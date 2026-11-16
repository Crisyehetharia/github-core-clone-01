// GraphQL v4: a small hand-rolled parser + executor for the documents gh and
// github-mcp-server send (viewer, repository, issue/pull-request reads, the
// create/close/merge mutations, __type introspection, node(id:), batching).
// No GraphQL library; only node built-ins (via store.ts).

import { diffFiles, gid, mergePull, mergeWouldConflict, parseGid, type Issue, type Pull, type Repo, type Store } from './store.ts';

// -------------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode { kind: 'field'; alias: string; name: string; args: { name: string; value: ValueNode }[]; children: SelectionNode[]; }
interface FragmentNode { kind: 'fragment'; typeName: string; children: SelectionNode[]; }
type SelectionNode = FieldNode | FragmentNode;

interface Operation { type: 'query' | 'mutation'; name: string | null; selections: SelectionNode[]; }

class Parser {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) { this.src = src; }

  private skipWs(): void {
    for (;;) {
      while (this.pos < this.src.length && /[\s,]/.test(this.src[this.pos]!)) this.pos += 1;
      if (this.src[this.pos] === '#') { while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1; continue; }
      break;
    }
  }

  private peek(): string { this.skipWs(); return this.src[this.pos] ?? ''; }
  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) throw new Error(`expected '${ch}' at ${this.pos}`);
    this.pos += 1;
  }
  private matchWord(word: string): boolean {
    this.skipWs();
    if (this.src.startsWith(word, this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + word.length] ?? '')) {
      this.pos += word.length;
      return true;
    }
    return false;
  }

  private readName(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected name at ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private readString(): string {
    this.skipWs();
    if (this.src[this.pos] !== '"') throw new Error(`expected string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === '"') { this.pos += 1; return out; }
      if (ch === '\\') {
        const esc = this.src[this.pos + 1]!;
        this.pos += 2;
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }

  private readInt(): number {
    this.skipWs();
    const m = /^-?\d+/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`expected int at ${this.pos}`);
    this.pos += m[0].length;
    return parseInt(m[0], 10);
  }

  parseValue(): ValueNode {
    this.skipWs();
    const ch = this.src[this.pos]!;
    if (ch === '$') { this.pos += 1; return { kind: 'var', name: this.readName() }; }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: { name: string; value: ValueNode }[] = [];
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) return { kind: 'int', value: this.readInt() };
    const name = this.readName();
    if (name === 'true') return { kind: 'bool', value: true };
    if (name === 'false') return { kind: 'bool', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private parseArgs(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.skipWs();
    if (this.src[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private skipVarDefs(): void {
    this.skipWs();
    if (this.src[this.pos] !== '(') return;
    // ($x: Type! = default, ...) — skip balanced parens, strings inside are rare; handle simply.
    let depth = 0;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === '"') this.readString();
      else if (ch === '(' || ch === '[' || ch === '{') { depth += 1; this.pos += 1; }
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1; this.pos += 1;
        if (depth === 0) return;
      } else this.pos += 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const sels: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.src.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipWs();
        if (this.matchWord('on')) {
          const typeName = this.readName();
          sels.push({ kind: 'fragment', typeName, children: this.parseSelectionSet() });
        } else {
          // named fragment spread: not used by the suite; skip its selection set if any
          this.readName();
        }
        continue;
      }
      const first = this.readName();
      let alias = first;
      let name = first;
      this.skipWs();
      if (this.src[this.pos] === ':') {
        this.pos += 1;
        name = this.readName();
      }
      const args = this.parseArgs();
      const children = this.peek() === '{' ? this.parseSelectionSet() : [];
      sels.push({ kind: 'field', alias, name, args, children });
    }
    this.expect('}');
    return sels;
  }

  parseOperation(): Operation {
    this.skipWs();
    let type: 'query' | 'mutation' = 'query';
    if (this.matchWord('query')) type = 'query';
    else if (this.matchWord('mutation')) type = 'mutation';
    let name: string | null = null;
    this.skipWs();
    if (/[A-Za-z_]/.test(this.peek())) name = this.readName();
    this.skipVarDefs();
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }
}

// -------------------------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// -------------------------------------------------------------------------------- values

type Wrapped =
  | { __kind: 'User'; login: string }
  | { __kind: 'Repository'; repo: Repo }
  | { __kind: 'Issue'; repo: Repo; issue: Issue }
  | { __kind: 'PullRequest'; repo: Repo; pull: Pull }
  | { __kind: 'IssueConnection'; repo: Repo; nodes: Issue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  | { __kind: 'PullRequestConnection'; repo: Repo; nodes: Pull[] }
  | { __kind: 'ChangedFileConnection'; repo: Repo; pull: Pull; nodes: { path: string; additions: number; deletions: number }[] }
  | { __kind: 'ChangedFile'; path: string; additions: number; deletions: number }
  | { __kind: 'Ref'; name: string }
  | { __kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __kind: 'Type'; name: string }
  | { __kind: 'TypeField'; name: string }
  | { __kind: 'TypeEnumValue'; name: string }
  | { __kind: 'CommentEdge'; repo: Repo; issue: Issue; comment: { id: number; body: string } };

function kindOf(v: Wrapped): string {
  switch (v.__kind) {
    case 'User': return 'User';
    case 'Repository': return 'Repository';
    case 'Issue': return 'Issue';
    case 'PullRequest': return 'PullRequest';
    case 'IssueConnection': return 'IssueConnection';
    case 'PullRequestConnection': return 'PullRequestConnection';
    case 'ChangedFileConnection': return 'PullRequestChangedFileConnection';
    case 'ChangedFile': return 'PullRequestChangedFile';
    case 'Ref': return 'Ref';
    case 'PageInfo': return 'PageInfo';
    case 'Type': return '__Type';
    case 'TypeField': return '__Field';
    case 'TypeEnumValue': return '__EnumValue';
    case 'CommentEdge': return 'IssueCommentEdge';
  }
}

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': return vars[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, vars);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1]!, 10) : null;
  } catch { return null; }
}

// -------------------------------------------------------------------------------- executor

class Executor {
  readonly errors: { message: string }[] = [];
  private readonly store: Store;
  private readonly viewerLogin: string;
  constructor(store: Store, viewerLogin: string) { this.store = store; this.viewerLogin = viewerLogin; }

  execute(op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    for (const sel of op.selections) {
      if (sel.kind === 'fragment') continue;
      data[sel.alias] = this.resolveRoot(sel, rootType, variables);
    }
    return data;
  }

  private resolveRoot(field: FieldNode, rootType: string, vars: Record<string, unknown>): unknown {
    const allowed = TYPE_FIELDS[rootType] ?? [];
    if (!allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${rootType}".` });
      return null;
    }
    const args = argsOf(field, vars);
    if (rootType === 'Query') {
      if (field.name === 'viewer') return this.select({ __kind: 'User', login: this.viewerLogin }, field.children, vars);
      if (field.name === 'repository') {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo) return null;
        return this.select({ __kind: 'Repository', repo }, field.children, vars);
      }
      if (field.name === 'node') {
        const parsed = parseGid(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const [owner, name] = parsed.key.split('/');
          const repo = owner && name ? this.store.getRepo(owner, name) : undefined;
          if (!repo) return null;
          return this.select({ __kind: 'Repository', repo }, field.children, vars);
        }
        if (parsed.kind === 'Issue') {
          const m = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
          if (!m) return null;
          const repo = this.store.getRepo(m[1]!, m[2]!);
          const issue = repo?.issues.find((i) => i.number === parseInt(m[3]!, 10));
          if (!repo || !issue) return null;
          return this.select({ __kind: 'Issue', repo, issue }, field.children, vars);
        }
        if (parsed.kind === 'PullRequest') {
          const m = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
          if (!m) return null;
          const repo = this.store.getRepo(m[1]!, m[2]!);
          const pull = repo?.pulls.find((p) => p.number === parseInt(m[3]!, 10));
          if (!repo || !pull) return null;
          return this.select({ __kind: 'PullRequest', repo, pull }, field.children, vars);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (!TYPE_FIELDS[name] && !ENUM_VALUES[name]) return null;
        return this.select({ __kind: 'Type', name }, field.children, vars);
      }
    } else {
      return this.mutation(field, args, vars);
    }
    return null;
  }

  private mutation(field: FieldNode, args: Record<string, unknown>, vars: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository') { this.errors.push({ message: 'createIssue: unknown repository id' }); return null; }
      const [owner, name] = parsed.key.split('/');
      const repo = owner && name ? this.store.getRepo(owner, name) : undefined;
      if (!repo) { this.errors.push({ message: 'createIssue: unknown repository' }); return null; }
      const issue: Issue = {
        id: this.store.nextId(), number: repo.nextNumber++, title: String(input.title ?? ''), body: String(input.body ?? ''),
        state: 'open', labels: [], seq: repo.issues.length + 1, comments: [],
      };
      repo.issues.push(issue);
      return this.select({ __kind: 'Issue', repo, issue }, field.children, vars, 'createIssue');
    }
    if (field.name === 'closeIssue') {
      const found = this.findIssue(String(input.issueId ?? ''));
      if (!found) { this.errors.push({ message: 'closeIssue: unknown issue id' }); return null; }
      found.issue.state = 'closed';
      return this.select({ __kind: 'Issue', repo: found.repo, issue: found.issue }, field.children, vars, 'closeIssue');
    }
    if (field.name === 'createPullRequest') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository') { this.errors.push({ message: 'createPullRequest: unknown repository id' }); return null; }
      const [owner, name] = parsed.key.split('/');
      const repo = owner && name ? this.store.getRepo(owner, name) : undefined;
      if (!repo) { this.errors.push({ message: 'createPullRequest: unknown repository' }); return null; }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.resolveCommit(headRef);
      const baseSha = repo.resolveCommit(baseRef);
      if (headSha === null || baseSha === null) { this.errors.push({ message: 'createPullRequest: unknown head or base ref' }); return null; }
      const pull: Pull = {
        id: this.store.nextId(), number: repo.nextNumber++, title: String(input.title ?? ''), body: String(input.body ?? ''),
        state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
        headRef, headSha, baseRef, baseSha, seq: repo.pulls.length + 1,
      };
      repo.pulls.push(pull);
      return this.select({ __kind: 'PullRequest', repo, pull }, field.children, vars, 'createPullRequest');
    }
    if (field.name === 'mergePullRequest') {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'PullRequest') { this.errors.push({ message: 'mergePullRequest: unknown pull request id' }); return null; }
      const m = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
      if (!m) { this.errors.push({ message: 'mergePullRequest: unknown pull request id' }); return null; }
      const repo = this.store.getRepo(m[1]!, m[2]!);
      const pull = repo?.pulls.find((p) => p.number === parseInt(m[3]!, 10));
      if (!repo || !pull) { this.errors.push({ message: 'mergePullRequest: unknown pull request' }); return null; }
      const sha = mergePull(repo, pull);
      if (sha === null) { this.errors.push({ message: 'mergePullRequest: merge conflict' }); return null; }
      return this.select({ __kind: 'PullRequest', repo, pull }, field.children, vars, 'mergePullRequest');
    }
    if (field.name === 'addComment') {
      const found = this.findIssue(String(input.subjectId ?? ''));
      if (!found) { this.errors.push({ message: 'addComment: unknown subject id' }); return null; }
      const comment = { id: this.store.nextId(), body: String(input.body ?? ''), seq: found.issue.comments.length + 1 };
      found.issue.comments.push(comment);
      return this.select({ __kind: 'CommentEdge', repo: found.repo, issue: found.issue, comment }, field.children, vars, 'addComment');
    }
    return null;
  }

  private findIssue(id: string): { repo: Repo; issue: Issue } | null {
    const parsed = parseGid(id);
    if (!parsed || parsed.kind !== 'Issue') return null;
    const m = /^(.+)\/([^/]+)#(\d+)$/.exec(parsed.key);
    if (!m) return null;
    const repo = this.store.getRepo(m[1]!, m[2]!);
    const issue = repo?.issues.find((i) => i.number === parseInt(m[3]!, 10));
    if (!repo || !issue) return null;
    return { repo, issue };
  }

  /** Resolve a wrapper's selected fields. `payloadKey` unwraps mutation payloads (createIssue -> issue). */
  private select(value: Wrapped, selections: SelectionNode[], vars: Record<string, unknown>, payloadKey?: string): unknown {
    let target: Wrapped = value;
    if (payloadKey !== undefined) {
      // The mutation field's children name the payload object (issue / pullRequest / commentEdge).
      const out: Record<string, unknown> = {};
      for (const sel of selections) {
        if (sel.kind === 'fragment') continue;
        out[sel.alias] = this.payloadField(value, sel, vars);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'fragment') {
        if (sel.typeName === kindOf(target)) {
          Object.assign(out, this.select(target, sel.children, vars) as Record<string, unknown>);
        }
        continue;
      }
      out[sel.alias] = this.field(target, sel, vars);
    }
    return out;
  }

  private payloadField(value: Wrapped, field: FieldNode, vars: Record<string, unknown>): unknown {
    // createIssue.issue, closeIssue.issue, createPullRequest.pullRequest,
    // mergePullRequest.pullRequest, addComment.commentEdge
    if (field.name === 'issue' && (value.__kind === 'Issue')) return this.select(value, field.children, vars);
    if (field.name === 'pullRequest' && value.__kind === 'PullRequest') return this.select(value, field.children, vars);
    if (field.name === 'commentEdge' && value.__kind === 'CommentEdge') {
      const out: Record<string, unknown> = {};
      for (const sel of field.children) {
        if (sel.kind === 'fragment') continue;
        if (sel.name === 'node') {
          out[sel.alias] = {
            id: gid('Comment', `${value.repo.fullName}#${value.issue.number}:${value.comment.id}`),
            body: value.comment.body,
          };
        }
      }
      return out;
    }
    return null;
  }

  private field(value: Wrapped, field: FieldNode, vars: Record<string, unknown>): unknown {
    const typeName = kindOf(value);
    const allowed = TYPE_FIELDS[typeName] ?? [];
    if (!allowed.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    const args = argsOf(field, vars);
    switch (value.__kind) {
      case 'User':
        if (field.name === 'login') return value.login;
        if (field.name === 'id') return gid('User', value.login);
        if (field.name === 'name') return value.login;
        return null;
      case 'Repository': {
        const repo = value.repo;
        switch (field.name) {
          case 'id': return gid('Repository', repo.fullName);
          case 'databaseId': return repo.id;
          case 'name': return repo.name;
          case 'nameWithOwner': return repo.fullName;
          case 'owner': return this.select({ __kind: 'User', login: repo.owner }, field.children, vars);
          case 'defaultBranchRef': return this.select({ __kind: 'Ref', name: repo.defaultBranch }, field.children, vars);
          case 'viewerPermission': return 'ADMIN';
          case 'hasIssuesEnabled': return true;
          case 'description': return repo.description;
          case 'private': return repo.isPrivate;
          case 'url': return `https://example.invalid/${repo.fullName}`;
          case 'createdAt': return new Date().toISOString();
          case 'issue': {
            const issue = repo.issues.find((i) => i.number === Number(args.number));
            if (!issue) return null;
            return this.select({ __kind: 'Issue', repo, issue }, field.children, vars);
          }
          case 'issues': return this.select(this.issuesConnection(repo, args), field.children, vars);
          case 'pullRequests': {
            const first = typeof args.first === 'number' ? args.first : 100;
            const nodes = repo.pulls.filter((p) => p.state === 'open').slice(0, first);
            return this.select({ __kind: 'PullRequestConnection', repo, nodes }, field.children, vars);
          }
          case 'pullRequest': {
            const pull = repo.pulls.find((p) => p.number === Number(args.number));
            if (!pull) return null;
            return this.select({ __kind: 'PullRequest', repo, pull }, field.children, vars);
          }
        }
        return null;
      }
      case 'Issue': {
        const { repo, issue } = value;
        switch (field.name) {
          case 'id': return gid('Issue', `${repo.fullName}#${issue.number}`);
          case 'number': return issue.number;
          case 'title': return issue.title;
          case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'body': return issue.body;
          case 'url': return `https://example.invalid/${repo.fullName}/issues/${issue.number}`;
          case 'createdAt': case 'updatedAt': return new Date().toISOString();
          case 'author': return this.select({ __kind: 'User', login: repo.owner }, field.children, vars);
          case 'labels': return issue.labels.map((l) => ({ name: l }));
          case 'comments': return issue.comments.map((c) => ({ id: gid('Comment', `${repo.fullName}#${issue.number}:${c.id}`), body: c.body }));
        }
        return null;
      }
      case 'PullRequest': {
        const { repo, pull } = value;
        switch (field.name) {
          case 'id': return gid('PullRequest', `${repo.fullName}#${pull.number}`);
          case 'number': return pull.number;
          case 'title': return pull.title;
          case 'body': return pull.body;
          case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
          case 'merged': return pull.merged;
          case 'mergeable': {
            const baseTip = repo.resolveCommit(pull.baseRef);
            const headTip = repo.resolveCommit(pull.headRef);
            if (baseTip === null || headTip === null) return 'UNKNOWN';
            return mergeWouldConflict(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
          }
          case 'headRefName': return pull.headRef;
          case 'baseRefName': return pull.baseRef;
          case 'headRef': return this.select({ __kind: 'Ref', name: pull.headRef }, field.children, vars);
          case 'baseRef': return this.select({ __kind: 'Ref', name: pull.baseRef }, field.children, vars);
          case 'files': {
            const baseTip = repo.resolveCommit(pull.baseRef);
            const headTip = repo.resolveCommit(pull.headRef);
            const first = typeof args.first === 'number' ? args.first : 100;
            const nodes = baseTip !== null && headTip !== null
              ? diffFiles(repo, baseTip, headTip).slice(0, first).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }))
              : [];
            return this.select({ __kind: 'ChangedFileConnection', repo, pull, nodes }, field.children, vars);
          }
        }
        return null;
      }
      case 'IssueConnection':
        if (field.name === 'nodes') return value.nodes.map((issue) => this.select({ __kind: 'Issue', repo: value.repo, issue }, field.children, vars));
        if (field.name === 'pageInfo') return this.select({ __kind: 'PageInfo', hasNextPage: value.pageInfo.hasNextPage, endCursor: value.pageInfo.endCursor }, field.children, vars);
        if (field.name === 'totalCount') return value.nodes.length;
        if (field.name === 'edges') return value.nodes.map((issue) => ({ node: this.select({ __kind: 'Issue', repo: value.repo, issue }, field.children, vars), cursor: cursorFor(issue.number) }));
        return null;
      case 'PullRequestConnection':
        if (field.name === 'nodes') return value.nodes.map((pull) => this.select({ __kind: 'PullRequest', repo: value.repo, pull }, field.children, vars));
        if (field.name === 'pageInfo') return this.select({ __kind: 'PageInfo', hasNextPage: false, endCursor: null }, field.children, vars);
        if (field.name === 'totalCount') return value.nodes.length;
        if (field.name === 'edges') return value.nodes.map((pull) => ({ node: this.select({ __kind: 'PullRequest', repo: value.repo, pull }, field.children, vars), cursor: cursorFor(pull.number) }));
        return null;
      case 'ChangedFileConnection':
        if (field.name === 'nodes') return value.nodes.map((n) => this.select({ __kind: 'ChangedFile', ...n }, field.children, vars));
        if (field.name === 'pageInfo') return this.select({ __kind: 'PageInfo', hasNextPage: false, endCursor: null }, field.children, vars);
        if (field.name === 'totalCount') return value.nodes.length;
        return null;
      case 'ChangedFile':
        if (field.name === 'path') return value.path;
        if (field.name === 'additions') return value.additions;
        if (field.name === 'deletions') return value.deletions;
        if (field.name === 'changeType') return 'MODIFIED';
        return null;
      case 'Ref':
        if (field.name === 'name') return value.name;
        if (field.name === 'target') return null;
        return null;
      case 'PageInfo':
        if (field.name === 'hasNextPage') return value.hasNextPage;
        if (field.name === 'hasPreviousPage') return false;
        if (field.name === 'endCursor') return value.endCursor;
        if (field.name === 'startCursor') return null;
        return null;
      case 'Type': {
        const name = value.name;
        const isEnum = ENUM_VALUES[name] !== undefined;
        if (field.name === 'name') return name;
        if (field.name === 'kind') return isEnum ? 'ENUM' : 'OBJECT';
        if (field.name === 'description') return null;
        if (field.name === 'fields') {
          if (isEnum) return null;
          return (TYPE_FIELDS[name] ?? []).map((n) => this.select({ __kind: 'TypeField', name: n }, field.children, vars));
        }
        if (field.name === 'enumValues') {
          if (!isEnum) return null;
          return (ENUM_VALUES[name] ?? []).map((n) => this.select({ __kind: 'TypeEnumValue', name: n }, field.children, vars));
        }
        return null;
      }
      case 'TypeField':
        if (field.name === 'name') return value.name;
        if (field.name === 'description') return null;
        return null;
      case 'TypeEnumValue':
        if (field.name === 'name') return value.name;
        if (field.name === 'description') return null;
        return null;
      case 'CommentEdge':
        return null;
    }
  }

  private issuesConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
    let list = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
    const dir = orderBy?.direction === 'ASC' ? 1 : -1;
    // CREATED_AT (default) orders by creation; ties by number DESC per the rules.
    list.sort((a, b) => dir * (a.number - b.number));
    const after = numberFromCursor(args.after);
    if (after !== null) {
      const idx = list.findIndex((i) => i.number === after);
      if (idx >= 0) list = list.slice(idx + 1);
    }
    const first = typeof args.first === 'number' ? args.first : 100;
    const page = list.slice(0, first);
    const hasNextPage = list.length > page.length;
    const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
    return { __kind: 'IssueConnection', repo, nodes: page, pageInfo: { hasNextPage, endCursor } };
  }
}

// -------------------------------------------------------------------------------- entry point

export interface GraphQLResult { status: number; body: unknown; }

/** Execute one GraphQL request body (single operation or a batch array). */
export function handleGraphQL(store: Store, viewerLogin: string, body: unknown): GraphQLResult {
  const runOne = (opBody: unknown): Record<string, unknown> => {
    if (typeof opBody !== 'object' || opBody === null || Array.isArray(opBody)) {
      return { data: null, errors: [{ message: 'expected a GraphQL operation object' }] };
    }
    const { query, variables } = opBody as { query?: unknown; variables?: unknown };
    if (typeof query !== 'string') {
      return { data: null, errors: [{ message: 'expected a query string' }] };
    }
    const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}) as Record<string, unknown>;
    let op: Operation;
    try {
      op = new Parser(query).parseOperation();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const ex = new Executor(store, viewerLogin);
    let data: Record<string, unknown>;
    try {
      data = ex.execute(op, vars);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (ex.errors.length > 0) return { data, errors: ex.errors };
    return { data };
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
