// In-memory store shared by git, REST, GraphQL and MCP: one Repo holds its refs,
// objects, issues, pull requests, labels and comments.

import { buildTree, collectReachable, hashObject, isAncestor, isOid, parseCommit, parseTag, parseTree, ZERO_OID, type GitObject, type ObjType } from './gitobj.ts';

export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const DEFAULT_BRANCH = 'main';

export interface Comment { id: number; body: string; seq: number; }
export interface Issue { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; seq: number; comments: Comment[]; }
export interface Pull {
  id: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; merged_at: string | null; merge_commit_sha: string | null;
  headRef: string; headSha: string; baseRef: string; baseSha: string; seq: number;
}

export interface Label { name: string; color: string; }

let globalSeq = 1;

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch = DEFAULT_BRANCH;
  readonly refs = new Map<string, string>();
  readonly objects = new Map<string, GitObject>();
  readonly labels = new Map<string, Label>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextNumber = 1;
  readonly createdSeq: number;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id; this.owner = owner; this.name = name;
    this.isPrivate = isPrivate; this.description = description;
    this.createdSeq = globalSeq++;
  }

  get fullName(): string { return `${this.owner}/${this.name}`; }
  lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  storeObjects(objects: Iterable<GitObject>): void {
    for (const o of objects) {
      const oid = hashObject(o.type, o.data);
      if (!this.objects.has(oid)) this.objects.set(oid, { type: o.type, data: o.data });
    }
  }

  /** Resolve a branch name, full ref or oid to a commit oid (following annotated tags). */
  resolveCommit(ref: string): string | null {
    let oid: string | undefined;
    if (this.refs.has(`refs/heads/${ref}`)) oid = this.refs.get(`refs/heads/${ref}`);
    else if (this.refs.has(ref)) oid = this.refs.get(ref);
    else if (isOid(ref) && this.objects.has(ref)) oid = ref;
    if (oid === undefined || oid === ZERO_OID) return null;
    let obj = this.objects.get(oid);
    let guard = 0;
    while (obj && obj.type === 'tag' && guard++ < 10) {
      oid = parseTag(obj.data).object;
      obj = this.objects.get(oid);
    }
    if (!obj || obj.type !== 'commit') return null;
    return oid;
  }

  /** Flat path -> {oid, mode} map of a commit's tree. */
  flatTree(commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Build (and store) nested trees from a flat path map; returns the root tree oid. */
  buildTreeFromFlat(files: Map<string, { oid: string; mode: string }>): string {
    interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node>; }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of files) {
      const segs = path.split('/');
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const s = segs[i]!;
        if (!node.dirs.has(s)) node.dirs.set(s, make());
        node = node.dirs.get(s)!;
      }
      node.files.set(segs[segs.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  createCommit(tree: string, parents: string[], message: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const who = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
    const lines = [`tree ${tree}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    return this.putObject('commit', Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8'));
  }

  /** Commits reachable from `ref`, tip first (depth-first parent walk). */
  commitList(ref: string): { sha: string; message: string }[] {
    const tip = this.resolveCommit(ref);
    if (tip === null) return [];
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      out.push({ sha: oid, message: c.message });
      for (let i = c.parents.length - 1; i >= 0; i -= 1) stack.push(c.parents[i]!);
    }
    return out;
  }

  /** Immediate children of a directory path in a commit's tree ('' = root). */
  listDir(commitOid: string, dir: string): { type: 'file' | 'dir'; name: string; path: string; sha: string }[] {
    const flat = this.flatTree(commitOid);
    const prefix = dir === '' ? '' : `${dir}/`;
    const out = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, e] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, { type: 'file', name: rest, path, sha: e.oid });
      else {
        const name = rest.slice(0, slash);
        if (!out.has(name)) {
          // find the subtree oid for the sha: rebuild is wasteful; use the tree oid from the walk
          out.set(name, { type: 'dir', name, path: `${prefix}${name}`, sha: this.dirTreeOid(commitOid, `${prefix}${name}`) });
        }
      }
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private dirTreeOid(commitOid: string, dir: string): string {
    const commit = this.objects.get(commitOid);
    if (!commit || commit.type !== 'commit') return ZERO_OID;
    let treeOid = parseCommit(commit.data).tree;
    for (const seg of dir.split('/')) {
      const tree = this.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return ZERO_OID;
      const e = parseTree(tree.data).find((x) => x.name === seg && x.mode === '40000');
      if (!e) return ZERO_OID;
      treeOid = e.oid;
    }
    return treeOid;
  }

  blobAt(commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const flat = this.flatTree(commitOid);
    const e = flat.get(path);
    if (!e) return null;
    const obj = this.objects.get(e.oid);
    if (!obj || obj.type !== 'blob') return null;
    return { oid: e.oid, data: obj.data };
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextRestId = 1;
  reqSeq = 1;

  key(owner: string, name: string): string { return `${owner}/${name}`; }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const k = this.key(owner, name);
    if (this.repos.has(k)) return null;
    const repo = new Repo(this.nextRepoId++, owner, name, isPrivate, description);
    this.repos.set(k, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextId(): number { return this.nextRestId++; }
  nextReqId(): string { return `req-${this.reqSeq++}`; }
}

// -------------------------------------------------------------------------------- global ids

export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch { return null; }
}

// -------------------------------------------------------------------------------- diff / merge

export interface FileChange { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number; }

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Simple LCS line diff (files here are small). */
function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = oldData.toString('utf8').split('\n');
  const b = newData.toString('utf8').split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length; const m = b.length;
  // LCS via DP over the shorter dimension; files are a few KB at most.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j]! = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: m - common, deletions: n - common };
}

export function diffFiles(repo: Repo, baseCommit: string, headCommit: string): FileChange[] {
  const base = repo.flatTree(baseCommit);
  const head = repo.flatTree(headCommit);
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path); const h = head.get(path);
    if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(data);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(data);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const d = lineDiff(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0), repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queue = [a];
  while (queue.length) {
    const oid = queue.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) queueB.push(p);
  }
  return null;
}

/** Three-way merge of head into base. Returns the merged tree's flat map, or null on conflict. */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): Map<string, { oid: string; mode: string }> | null {
  const base = mergeBase(repo, baseTip, headTip);
  const baseFlat = base === null ? new Map<string, { oid: string; mode: string }>() : repo.flatTree(base);
  const baseTipFlat = repo.flatTree(baseTip);
  const headFlat = repo.flatTree(headTip);
  const merged = new Map(baseTipFlat);
  const paths = new Set([...baseFlat.keys(), ...baseTipFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const o = baseFlat.get(path); const b = baseTipFlat.get(path); const h = headFlat.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    if (same(h, o)) { /* head unchanged: keep base */ continue; }
    if (same(b, o)) { /* base unchanged: take head */ if (h) merged.set(path, h); else merged.delete(path); continue; }
    if (same(b, h)) continue; // both changed to the same thing
    return null; // both changed differently: conflict
  }
  return merged;
}

/** Whether merging head into base would conflict. */
export function mergeWouldConflict(repo: Repo, baseTip: string, headTip: string): boolean {
  return threeWayMerge(repo, baseTip, headTip) === null;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null on conflict. */
export function mergePull(repo: Repo, pull: Pull): string | null {
  const baseTip = repo.resolveCommit(pull.baseRef);
  const headTip = repo.resolveCommit(pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const merged = threeWayMerge(repo, baseTip, headTip);
  if (merged === null) return null;
  const tree = repo.buildTreeFromFlat(merged);
  const sha = repo.createCommit(tree, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = new Date().toISOString();
  pull.merge_commit_sha = sha;
  pull.baseSha = sha;
  return sha;
}

/** Is `oid` an ancestor of `tip` (fast-forward test), following tags. */
export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  return isAncestor(oldOid, newOid, repo.lookup);
}
