// The forge server: git smart HTTP, REST v3, GraphQL v4 and MCP on one in-memory store.
// Only node:http and own files. Entry point contract: createApp() returns a Server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { diffFiles, gid, mergePull, mergeWouldConflict, Store, VIEWER, type Issue, type Pull, type Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const store = new Store();

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': store.nextReqId(), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': store.nextReqId(), ...headers });
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': store.nextReqId() });
  res.end();
}

function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  return typeof h === 'string' && /^Bearer\s+\S+$/.test(h);
}

function parseUrl(req: IncomingMessage): { path: string; q: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { path: u.pathname, q: u.searchParams };
  } catch {
    return { path: '/', q: new URLSearchParams() };
  }
}

function segments(path: string): string[] {
  const clean = path.replace(/\/+$/, '') || '/';
  return clean.split('/').filter((s) => s !== '').map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(req: IncomingMessage, path: string, q: URLSearchParams, items: T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(q);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(path, `http://${req.headers.host ?? 'entry'}`);
    for (const [k, v] of q) if (k !== 'page') url.searchParams.set(k, v);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function sendPage<T>(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams, items: T[]): void {
  const { page, link } = paginate(req, path, q, items);
  sendJson(res, 200, page, link === null ? {} : { link });
}

// -------------------------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repo.fullName),
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', `${repo.fullName}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repo.fullName}#${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    mergeable: (() => {
      const b = repo.resolveCommit(pull.baseRef);
      const h = repo.resolveCommit(pull.headRef);
      if (b === null || h === null) return null;
      return !mergeWouldConflict(repo, b, h);
    })(),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner } },
    user: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: `https://example.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function getRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (!repo) { errJson(res, 404, 'Not Found'); return null; }
  return repo;
}

// -------------------------------------------------------------------------------- contents helpers

function contentsFileJson(repo: Repo, path: string, blobSha: string, data: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop() ?? path,
    path,
    content: data.toString('base64'),
    sha: blobSha,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

// -------------------------------------------------------------------------------- REST handlers

async function handleRest(req: IncomingMessage, res: ServerResponse, method: string, path: string, q: URLSearchParams): Promise<void> {
  const seg = segments(path);
  // seg[0] === 'api', seg[1] === 'v3'
  const rest = seg.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    errJson(res, 404, 'Not Found'); return;
  }

  const needBody = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
  let bodyValue: unknown = {};
  if (needBody) {
    const raw = await readBody(req);
    const parsed = parseJson(raw);
    if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return; }
    bodyValue = parsed.value;
  }
  const body = (bodyValue !== null && typeof bodyValue === 'object' && !Array.isArray(bodyValue) ? bodyValue : {}) as Record<string, unknown>;

  // GET /api/v3/meta
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0' }); return; }
    errJson(res, 404, 'Not Found'); return;
  }

  // GET /api/v3/user and /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
      return;
    }
    if (rest[1] === 'repos') {
      if (method === 'GET') {
        sendPage(req, res, path, q, store.listRepos(VIEWER.login).map(repoJson));
        return;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '' || name.includes('/')) { errJson(res, 422, 'Repository name is invalid'); return; }
        const repo = store.createRepo(VIEWER.login, name, body.private === true, typeof body.description === 'string' ? body.description : '');
        if (!repo) { errJson(res, 422, 'Repository already exists.'); return; }
        sendJson(res, 201, repoJson(repo));
        return;
      }
    }
    errJson(res, 404, 'Not Found'); return;
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1]!;
    const name = rest[2]!;
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = getRepoOr404(res, owner, name);
        if (repo) sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = getRepoOr404(res, owner, name);
        if (!repo) return;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        if (!store.getRepo(owner, name)) { errJson(res, 404, 'Not Found'); return; }
        store.deleteRepo(owner, name);
        sendEmpty(res, 204);
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    const repo = getRepoOr404(res, owner, name);
    if (!repo) return;

    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((b) => ({ name: b, commit: { sha: repo.refs.get(`refs/heads/${b}`) ?? '' }, protected: false }));
        sendJson(res, 200, list);
        return;
      }
      if (tail.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${tail[1]}`);
        if (sha === undefined) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { name: tail[1], commit: { sha }, protected: false });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    // commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = q.get('sha') ?? repo.defaultBranch;
      const list = repo.commitList(ref).map((c) => ({
        sha: c.sha,
        commit: { message: c.message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
        author: { login: repo.owner },
        parents: [],
      }));
      sendPage(req, res, path, q, list);
      return;
    }

    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) { errJson(res, 422, 'Invalid ref'); return; }
        if (repo.refs.has(ref)) { errJson(res, 422, 'Reference already exists'); return; }
        if (!repo.objects.has(sha)) { errJson(res, 422, 'Invalid sha'); return; }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = tail.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) { errJson(res, 404, 'Not Found'); return; }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      const refParam = q.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = repo.resolveCommit(refParam ?? repo.defaultBranch);
        if (tip === null) { errJson(res, 404, 'Not Found'); return; }
        if (filePath === '') {
          sendJson(res, 200, repo.listDir(tip, ''));
          return;
        }
        const blob = repo.blobAt(tip, filePath);
        if (blob) { sendJson(res, 200, contentsFileJson(repo, filePath, blob.oid, blob.data)); return; }
        const dir = repo.listDir(tip, filePath);
        if (dir.length > 0) { sendJson(res, 200, dir); return; }
        errJson(res, 404, 'Not Found'); return;
      }
      if (method === 'PUT') {
        const message = typeof body.message === 'string' ? body.message : '';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        if (filePath === '' || contentB64 === '') { errJson(res, 422, 'Invalid content'); return; }
        const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = repo.resolveCommit(branch);
        const flat = tip === null ? new Map<string, { oid: string; mode: string }>() : repo.flatTree(tip);
        const existing = flat.get(filePath);
        const isUpdate = existing !== undefined;
        if (isUpdate) {
          const sha = typeof body.sha === 'string' ? body.sha : '';
          if (sha !== existing.oid) { errJson(res, 409, 'The blob sha does not match the current blob'); return; }
        }
        const blobOid = repo.putObject('blob', data);
        flat.set(filePath, { oid: blobOid, mode: '100644' });
        const tree = repo.buildTreeFromFlat(flat);
        const commitSha = repo.createCommit(tree, tip === null ? [] : [tip], message);
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, isUpdate ? 200 : 201, {
          content: contentsFileJson(repo, filePath, blobOid, data),
          commit: { sha: commitSha },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const tip = repo.resolveCommit(branch);
        if (tip === null) { errJson(res, 404, 'Not Found'); return; }
        const flat = repo.flatTree(tip);
        const existing = flat.get(filePath);
        if (!existing) { errJson(res, 404, 'Not Found'); return; }
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (sha !== '' && sha !== existing.oid) { errJson(res, 409, 'The blob sha does not match the current blob'); return; }
        flat.delete(filePath);
        const tree = repo.buildTreeFromFlat(flat);
        const commitSha = repo.createCommit(tree, [tip], typeof body.message === 'string' ? body.message : '');
        repo.refs.set(`refs/heads/${branch}`, commitSha);
        sendJson(res, 200, { commit: { sha: commitSha } });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    // labels
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') { errJson(res, 422, 'Label name is required'); return; }
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        sendJson(res, 201, { name: labelName, color, description: '' });
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') { errJson(res, 422, 'Title is required'); return; }
          const labelNames: string[] = Array.isArray(body.labels)
            ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as { name?: unknown }).name)).filter((l): l is string => typeof l === 'string')
            : [];
          for (const l of labelNames) {
            if (!repo.labels.has(l)) { errJson(res, 422, `Label does not exist: ${l}`); return; }
          }
          const issue: Issue = {
            id: store.nextId(), number: repo.nextNumber++, title, body: typeof body.body === 'string' ? body.body : '',
            state: 'open', labels: labelNames, seq: repo.issues.length + 1, comments: [],
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          sendPage(req, res, path, q, list.map((i) => issueJson(repo, i)));
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      const num = parseInt(tail[1] ?? '', 10);
      const issue = Number.isInteger(num) ? repo.issues.find((i) => i.number === num) : undefined;
      if (tail.length === 2) {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'POST') {
          const commentBody = typeof body.body === 'string' ? body.body : '';
          if (commentBody === '') { errJson(res, 422, 'Comment body is required'); return; }
          const comment = { id: store.nextId(), body: commentBody, seq: issue.comments.length + 1 };
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: repo.owner } });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: repo.owner } })));
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const baseRaw = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const headRef = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const baseRef = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          if (title === '' || headRef === '') { errJson(res, 422, 'Title and head are required'); return; }
          const headSha = repo.resolveCommit(headRef);
          const baseSha = repo.resolveCommit(baseRef);
          if (headSha === null || baseSha === null) { errJson(res, 422, 'Head or base branch not found'); return; }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef);
          if (dup) { errJson(res, 422, 'A pull request already exists for this head branch'); return; }
          const pull: Pull = {
            id: store.nextId(), number: repo.nextNumber++, title, body: typeof body.body === 'string' ? body.body : '',
            state: 'open', merged: false, merged_at: null, merge_commit_sha: null,
            headRef, headSha, baseRef, baseSha, seq: repo.pulls.length + 1,
          };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          sendPage(req, res, path, q, list.map((p) => pullJson(repo, p)));
          return;
        }
        errJson(res, 404, 'Not Found'); return;
      }
      const num = parseInt(tail[1] ?? '', 10);
      const pull = Number.isInteger(num) ? repo.pulls.find((p) => p.number === num) : undefined;
      if (tail.length === 2) {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return; }
        errJson(res, 404, 'Not Found'); return;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        const files = diffFiles(repo, pull.baseSha, pull.headSha).map((f) => ({
          filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
        }));
        sendJson(res, 200, files);
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pull) { errJson(res, 404, 'Not Found'); return; }
        if (pull.merged) { errJson(res, 405, 'Pull request is already merged'); return; }
        const sha = mergePull(repo, pull);
        if (sha === null) { errJson(res, 405, 'Merge conflict'); return; }
        sendJson(res, 200, { merged: true, sha, message: 'Pull request successfully merged.' });
        return;
      }
      errJson(res, 404, 'Not Found'); return;
    }

    errJson(res, 404, 'Not Found'); return;
  }

  errJson(res, 404, 'Not Found');
}

// -------------------------------------------------------------------------------- server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const { path, q } = parseUrl(req);

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const suffix = gitMatch[3]!;
          if (suffix === 'info/refs' && method === 'GET') {
            const service = q.get('service') ?? '';
            const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const out = handleInfoRefs(store, owner, repoName, service, wantV2);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
          if (suffix === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const out = handleUploadPack(store, owner, repoName, body, wantV2);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
          if (suffix === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            const out = handleReceivePack(store, owner, repoName, body);
            sendBuffer(res, out.status, out.contentType, out.body);
            return;
          }
          errJson(res, 404, 'Not Found');
          return;
        }

        // GraphQL v4
        if (path === '/api/graphql') {
          if (!authed(req)) { errJson(res, 401, 'Unauthorized'); return; }
          if (method !== 'POST') { errJson(res, 404, 'Not Found'); return; }
          const raw = await readBody(req);
          const parsed = parseJson(raw);
          if (!parsed.ok) { errJson(res, 400, 'Invalid JSON body'); return; }
          const result = handleGraphQL(store, VIEWER.login, parsed.value);
          sendJson(res, result.status, result.body);
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (!authed(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
            return;
          }
          if (method !== 'POST') { errJson(res, 405, 'Method Not Allowed'); return; }
          const raw = await readBody(req);
          const result = handleMcp(store, VIEWER.login, raw);
          if (result.body === null) { sendEmpty(res, result.status); return; }
          sendJson(res, result.status, result.body);
          return;
        }

        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) { errJson(res, 401, 'Unauthorized'); return; }
          await handleRest(req, res, method, path, q);
          return;
        }

        errJson(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try {
            errJson(res, 500, err instanceof Error ? err.message : String(err));
          } catch { /* already gone */ }
        }
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });
}
