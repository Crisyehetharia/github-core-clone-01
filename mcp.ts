// MCP at /mcp: JSON-RPC 2.0 Streamable HTTP, modern era (server/discover, revision
// 2026-07-28), with the legacy initialize handshake as a fallback. Same store as REST.

import { gid, mergePull, type Repo, type Store } from './store.ts';

export interface McpResult { status: number; body: unknown; }

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the new repository.' },
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      body: { type: 'string', description: 'Pull request body.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'Owner login.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'integer', description: 'Pull request number.' },
      number: { type: 'integer', description: 'Pull request number (alias).' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: { type: 'object', properties: t.properties, required: t.required },
  }));
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: string[]; id: number }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: repo.fullName,
  };
}

/** Run one tool call against the store; returns a tool result object. */
function callTool(store: Store, viewerLogin: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const owner = str(args.owner) || viewerLogin;
  const repoName = str(args.repo ?? args.name);

  if (name === 'create_repo') {
    const repo = store.createRepo(owner, repoName, args.private === true, str(args.description));
    if (!repo) return toolError(`Repository ${owner}/${repoName} already exists.`);
    return toolResult(repoJson(repo));
  }

  const repo = repoName === '' ? undefined : store.getRepo(owner, repoName);
  if (name === 'get_repo') {
    if (!repo) return toolError(`Repository ${owner}/${repoName} not found.`);
    return toolResult(repoJson(repo));
  }
  if (!repo) return toolError(`Repository ${owner}/${repoName} not found.`);

  if (name === 'create_issue') {
    const issue = {
      id: store.nextId(), number: repo.nextNumber++, title: str(args.title), body: str(args.body),
      state: 'open' as const, labels: [] as string[], seq: repo.issues.length + 1, comments: [],
      nodeId: gid('Issue', `${repo.fullName}#${repo.nextNumber - 1}`),
    };
    repo.issues.push(issue);
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = str(args.state) || 'open';
    const list = repo.issues.filter((i) => state === 'all' || i.state === state);
    return toolResult(list.map((i) => issueJson(repo, i)));
  }
  if (name === 'create_pull_request') {
    const headRef = str(args.head);
    const baseRef = str(args.base) || repo.defaultBranch;
    const headSha = repo.resolveCommit(headRef);
    const baseSha = repo.resolveCommit(baseRef);
    if (headSha === null) return toolError(`Head branch ${headRef} not found.`);
    if (baseSha === null) return toolError(`Base branch ${baseRef} not found.`);
    const pull = {
      id: store.nextId(), number: repo.nextNumber++, title: str(args.title), body: str(args.body),
      state: 'open' as const, merged: false, merged_at: null, merge_commit_sha: null,
      headRef, headSha, baseRef, baseSha, seq: repo.pulls.length + 1,
      nodeId: gid('PullRequest', `${repo.fullName}#${repo.nextNumber - 1}`),
    };
    repo.pulls.push(pull);
    return toolResult({
      id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
      head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha },
    });
  }
  if (name === 'merge_pull_request') {
    const number = num(args.pull_number) ?? num(args.number);
    if (number === null) return toolError('pull_number is required.');
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return toolError(`Pull request #${number} not found.`);
    if (pull.merged) return toolError(`Pull request #${number} is already merged.`);
    const sha = mergePull(repo, pull);
    if (sha === null) return toolError(`Pull request #${number} has a merge conflict.`);
    return toolResult({ merged: true, number, sha, state: pull.state });
  }
  return toolError(`Unknown tool: ${name}`);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/** Handle one POST /mcp request. `rawBody` is the exact request bytes. */
export function handleMcp(store: Store, viewerLogin: string, rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = parsed as Record<string, unknown>;
  const id = (req.id ?? null) as unknown;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;

  // Notifications (no id) are answered 202 with no body.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
      ? params.protocolVersion
      : PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: wanted,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: toolsList() }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    // Map common argument synonyms onto the tool's own property names.
    const synonyms: Record<string, string[]> = {
      pull_number: ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
      repo: ['repo', 'repository', 'repository_name', 'repo_name'],
      name: ['name', 'repo', 'repository'],
    };
    const mapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      // keep the given key, and also fill the canonical property when it matches a synonym
      mapped[key] = value;
      for (const [canonical, alts] of Object.entries(synonyms)) {
        if (alts.includes(key) && tool.properties[canonical] !== undefined && mapped[canonical] === undefined) mapped[canonical] = value;
      }
    }
    const missing = tool.required.filter((r) => mapped[r] === undefined || mapped[r] === '' || mapped[r] === null);
    if (missing.length > 0) {
      return { status: 200, body: rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`) };
    }
    const result = callTool(store, viewerLogin, name, mapped);
    return { status: 200, body: rpcResult(id, result) };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
