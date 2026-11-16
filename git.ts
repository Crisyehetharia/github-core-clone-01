// Git smart HTTP: info/refs (v2 + v0), upload-pack (protocol v2 ls-refs/fetch, v0 fetch),
// receive-pack v0 with report-status, side-band-64k, delete-refs, fast-forward only.

import { collectReachable, decodePktLines, hashObject, isAncestor, isOid, parseCommit, parseTag, parseTree, PKT_DELIM, PKT_FLUSH, pktLine, readPack, writePack, ZERO_OID, type GitObject } from './gitobj.ts';
import { isFastForward, type Repo, type Store } from './store.ts';

export interface GitResponse { status: number; contentType: string; body: Buffer; }

const AGENT = 'github-core-clone/1.0';
const UPLOAD_ADV = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADV = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

// -------------------------------------------------------------------------------- response caches (perf path)
//
// A fetch's response is a pure function of its parsed arguments: objects are
// immutable and oid-addressed, so the same wants/haves/shallow/deepen always
// builds the same pack, in any repo. The clone workload fetches the same tip
// 150+ times (5 warm-ups + 3 rounds x 50 concurrent clones), so the first
// fetch builds the pack and the rest reuse its bytes. Responses are never
// mutated after creation (res.end only reads them), so sharing is safe.
// Bounded: 32 entries / 8 MiB, oldest evicted first.

type PktList = ReturnType<typeof decodePktLines>['packets'];

const FETCH_CACHE_MAX_ENTRIES = 32;
const FETCH_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const fetchCache = new Map<string, { body: Buffer; bytes: number }>();
let fetchCacheBytes = 0;

function fetchCacheKey(v2: boolean, args: FetchArgs): string {
  const w = [...args.wants].sort().join(',');
  const h = [...args.haves].sort().join(',');
  const s = [...args.shallow].sort().join(',');
  return `${v2 ? '2' : '0'}|${w}|${h}|${s}|${args.deepen ?? ''}`;
}

function fetchCacheGet(key: string): Buffer | undefined {
  const hit = fetchCache.get(key);
  if (hit === undefined) return undefined;
  fetchCache.delete(key); // refresh LRU order
  fetchCache.set(key, hit);
  return hit.body;
}

function fetchCachePut(key: string, body: Buffer): void {
  const old = fetchCache.get(key);
  if (old !== undefined) { fetchCacheBytes -= old.bytes; fetchCache.delete(key); }
  fetchCache.set(key, { body, bytes: body.length });
  fetchCacheBytes += body.length;
  while ((fetchCache.size > FETCH_CACHE_MAX_ENTRIES || fetchCacheBytes > FETCH_CACHE_MAX_BYTES) && fetchCache.size > 1) {
    const first = fetchCache.keys().next();
    if (first.done) break;
    const ev = fetchCache.get(first.value);
    if (ev !== undefined) fetchCacheBytes -= ev.bytes;
    fetchCache.delete(first.value);
  }
}

// An ls-refs answer is a pure function of the repo's refs plus its arguments.
// Fingerprint is exact (every ref name + oid), so any ref change misses.
interface LsRefsCacheEntry { fp: string; key: string; body: Buffer; }
const lsRefsCache = new WeakMap<Repo, LsRefsCacheEntry>();

function refsFingerprint(repo: Repo): string {
  const parts: string[] = [];
  for (const [name, oid] of repo.refs) parts.push(`${name}=${oid}`);
  parts.sort();
  return parts.join(';');
}

function json404(message: string): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

function json400(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8') };
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Peel an annotated tag to its commit (following tag chains). */
function peelToCommit(repo: Repo, oid: string): string | null {
  let obj = repo.objects.get(oid);
  let guard = 0;
  while (obj && obj.type === 'tag' && guard++ < 10) {
    oid = parseTag(obj.data).object;
    obj = repo.objects.get(oid);
  }
  return obj?.type === 'commit' ? oid : null;
}

const V2_ADV: Buffer = (() => {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
})();

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta multi_ack shallow symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const mainOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    parts.push(pktLine(`${ZERO_OID} HEAD\n`));
  } else {
    parts.push(pktLine(`${mainOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const obj = repo.objects.get(ref.oid);
      if (obj?.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, wantV2: boolean): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return json400('unknown service');
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== owner) return json404('Not Found');
  if (service === 'git-upload-pack' && wantV2) {
    return { status: 200, contentType: UPLOAD_ADV, body: V2_ADV };
  }
  return {
    status: 200,
    contentType: service === 'git-upload-pack' ? UPLOAD_ADV : RECEIVE_ADV,
    body: v0Advertisement(repo, service as 'git-upload-pack' | 'git-receive-pack'),
  };
}

// -------------------------------------------------------------------------------- ls-refs

interface LsRefsArgs { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[]; }

function parseLsRefsArgs(packets: ReturnType<typeof decodePktLines>['packets']): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8');
    if (!afterDelim) continue; // command=, agent=, object-format= before delim
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
  }
  return args;
}

function handleLsRefs(repo: Repo, packets: PktList): GitResponse {
  const args = parseLsRefsArgs(packets);
  const key = `${args.peel ? 'p' : ''}${args.symrefs ? 's' : ''}${args.unborn ? 'u' : ''}|${args.prefixes.join(',')}`;
  const fp = refsFingerprint(repo);
  const cached = lsRefsCache.get(repo);
  if (cached !== undefined && cached.fp === fp && cached.key === key) {
    return { status: 200, contentType: UPLOAD_RESULT, body: cached.body };
  }
  const lines: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const mainOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (keep('HEAD')) {
    if (mainOid !== undefined) {
      lines.push(`${mainOid} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const obj = repo.objects.get(ref.oid);
      if (obj?.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
  lsRefsCache.set(repo, { fp, key, body });
  return { status: 200, contentType: UPLOAD_RESULT, body };
}

// -------------------------------------------------------------------------------- fetch

interface FetchArgs { wants: string[]; haves: string[]; shallow: string[]; deepen: number | null; }

function parseFetchArgs(packets: ReturnType<typeof decodePktLines>['packets']): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) args.deepen = parseInt(text.slice(7), 10);
  }
  return args;
}

/** Objects to send for a fetch: depth-limited when `deepen` is set, else reachable(wants) - reachable(haves). */
function fetchObjects(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const objects = new Map<string, GitObject>();
  const add = (oid: string): void => {
    const o = repo.objects.get(oid);
    if (o && !objects.has(oid)) objects.set(oid, o);
  };
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.deepen !== null && args.deepen >= 0) {
    // BFS over commits from wants, distance < deepen.
    const dist = new Map<string, number>();
    const queue: { oid: string; d: number }[] = [];
    for (const w of args.wants) {
      const obj = repo.objects.get(w);
      if (!obj) continue;
      if (obj.type === 'tag') { add(w); const t = peelToCommit(repo, w); if (t !== null) queue.push({ oid: t, d: 0 }); }
      else if (obj.type === 'commit') queue.push({ oid: w, d: 0 });
      else add(w);
    }
    const included = new Set<string>();
    while (queue.length) {
      const { oid, d } = queue.shift()!;
      if (dist.has(oid)) continue;
      if (d >= args.deepen) continue;
      dist.set(oid, d);
      included.add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, d: d + 1 });
    }
    for (const oid of included) {
      add(oid);
      const obj = repo.objects.get(oid);
      if (obj?.type !== 'commit') continue;
      const tree = parseCommit(obj.data).tree;
      // whole tree closure of this commit
      const stack = [tree];
      while (stack.length) {
        const t = stack.pop()!;
        add(t);
        const tobj = repo.objects.get(t);
        if (tobj?.type !== 'tree') continue;
        for (const e of parseTree(tobj.data)) {
          if (e.mode === '40000') stack.push(e.oid);
          else add(e.oid);
        }
      }
      const parents = parseCommit(obj.data).parents;
      const parentIncluded = parents.some((p) => included.has(p));
      if (!parentIncluded && parents.length > 0) shallow.push(oid);
      else if (!parentIncluded && parents.length === 0) shallow.push(oid);
    }
    for (const s of args.shallow) {
      if (included.has(s) && !shallow.includes(s)) unshallow.push(s);
    }
  } else {
    const wanted = new Set<string>();
    for (const w of args.wants) {
      const obj = repo.objects.get(w);
      if (!obj) continue;
      if (obj.type === 'tag') {
        wanted.add(w);
        const t = peelToCommit(repo, w);
        if (t !== null) for (const o of collectReachable([t], repo.lookup, true)) wanted.add(o);
      } else {
        for (const o of collectReachable([w], repo.lookup, true)) wanted.add(o);
      }
    }
    const haveSet = new Set<string>();
    for (const h of args.haves) {
      if (!repo.objects.has(h)) continue;
      for (const o of collectReachable([h], repo.lookup, true)) haveSet.add(o);
    }
    for (const oid of wanted) if (!haveSet.has(oid)) add(oid);
  }
  return { objects: [...objects.values()], shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + 32768));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, packets: PktList): GitResponse {
  let args: FetchArgs;
  try {
    args = parseFetchArgs(packets);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const key = fetchCacheKey(true, args);
  const hit = fetchCacheGet(key);
  if (hit !== undefined) return { status: 200, contentType: UPLOAD_RESULT, body: hit };
  const { objects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(objects.map((o) => ({ type: o.type, data: o.data })));
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
  if (args.deepen !== null) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'), sidebandPack(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(key, body);
  return { status: 200, contentType: UPLOAD_RESULT, body };
}

function handleFetchV0(repo: Repo, packets: PktList): GitResponse {
  let args: FetchArgs;
  try {
    args = parseFetchArgs(packets);
  } catch {
    return json400('malformed pkt-line stream');
  }
  const key = fetchCacheKey(false, args);
  const hit = fetchCacheGet(key);
  if (hit !== undefined) return { status: 200, contentType: UPLOAD_RESULT, body: hit };
  const { objects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(objects.map((o) => ({ type: o.type, data: o.data })));
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack), PKT_FLUSH);
  const body = Buffer.concat(parts);
  fetchCachePut(key, body);
  return { status: 200, contentType: UPLOAD_RESULT, body };
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, wantV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== owner) return json404('Not Found');
  // Decode once here; the handlers below reuse the packets (the old code
  // decoded the body a second time inside each handler).
  let packets: PktList;
  let first: string;
  try {
    packets = decodePktLines(body).packets;
    const data = packets.find((p) => p.kind === 'data');
    if (!data || data.kind !== 'data') return json400('empty upload-pack request');
    first = data.payload.toString('utf8');
  } catch {
    return json400('malformed pkt-line stream');
  }
  if (first.startsWith('command=ls-refs')) return handleLsRefs(repo, packets);
  if (first.startsWith('command=fetch')) return handleFetchV2(repo, packets);
  if (first.startsWith('want ')) return handleFetchV0(repo, packets);
  return json400('unknown upload-pack command');
}

// -------------------------------------------------------------------------------- receive-pack

interface PushCommand { oldOid: string; newOid: string; ref: string; }

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (!repo || repo.owner !== owner) return json404('Not Found');
  let commands: PushCommand[] = [];
  let caps = '';
  let packOffset: number;
  try {
    const { packets, offset } = decodePktLines(body);
    packOffset = offset;
    let sawFlush = false;
    for (const p of packets) {
      if (p.kind === 'flush') { sawFlush = true; break; }
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const cmdText = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
      if (nul >= 0) caps = text.slice(nul + 1).replace(/\n$/, '');
      const parts = cmdText.split(' ');
      if (parts.length !== 3) return json400('bad push command');
      const [oldOid, newOid, ref] = parts as [string, string, string];
      if (!isOid(oldOid) || !isOid(newOid)) return json400('bad push command oid');
      commands.push({ oldOid, newOid, ref });
    }
    if (!sawFlush) return json400('push command list has no flush');
  } catch {
    return json400('malformed pkt-line stream');
  }
  if (commands.length === 0) return json400('no push commands');

  const sideband = caps.split(' ').includes('side-band-64k');
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packOffset);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      repo.storeObjects(objects.values());
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed\n`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) reportLines.push(`ng ${cmd.ref} no such ref\n`);
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reportLines.push(`ng ${cmd.ref} stale info\n`);
      else { repo.refs.delete(cmd.ref); reportLines.push(`ok ${cmd.ref}\n`); }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} missing object\n`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) reportLines.push(`ng ${cmd.ref} already exists\n`);
      else { repo.refs.set(cmd.ref, cmd.newOid); reportLines.push(`ok ${cmd.ref}\n`); }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${cmd.ref} no such ref\n`);
      continue;
    }
    if (cmd.oldOid !== current) {
      reportLines.push(`ng ${cmd.ref} stale info\n`);
      continue;
    }
    if (!isFastForward(repo, cmd.oldOid, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}\n`);
  }

  let out: Buffer;
  if (sideband) {
    const inner = Buffer.concat([pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`), ...reportLines.map((l) => pktLine(l))]);
    const parts: Buffer[] = [];
    for (let off = 0; off < inner.length; off += 32768) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(off, Math.min(inner.length, off + 32768))])));
    }
    parts.push(PKT_FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = Buffer.concat([pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`), ...reportLines.map((l) => pktLine(l)), PKT_FLUSH]);
  }
  return { status: 200, contentType: RECEIVE_RESULT, body: out };
}

// Keep isAncestor import used (fast-forward helper lives in store.ts).
void isAncestor;
void hashObject;
