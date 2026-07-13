// Pure helpers for the GitHub MCP proxy. Kept out of the top-level script so
// they can be unit-tested without spawning a subprocess.
//
// The proxy sits in front of `@modelcontextprotocol/server-github` and mints
// a fresh, narrowed installation token per `tools/call` via the Maskin API's
// `GET /api/integrations/:id/github-token?tool=<name>&repo=<owner/repo>` route
// (see `apps/dev/src/routes/integrations.ts`). Narrowing is derived from the
// invoked tool's name + the repo the caller is about to touch, keeping token
// blast radius bounded to a single repo + the minimum permission set.

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/

/**
 * Static tool inventory the proxy accepts. Must stay in lockstep with the
 * server-side mapping in `apps/dev/src/lib/integrations/providers/github/scope.ts`.
 * Extending here without extending scope.ts causes a 400 from the mint route;
 * extending scope.ts without extending here silently drops the tool.
 *
 * Values are the expected argument shape used to derive `owner/repo` for the
 * mint call — `both` uses `owner` + `repo`, `none` skips the repo narrowing.
 */
export const KNOWN_TOOLS = Object.freeze({
	// pull-request writes
	create_pull_request: 'both',
	create_pull_request_review: 'both',
	update_pull_request_branch: 'both',
	merge_pull_request: 'both',
	// contents writes
	create_or_update_file: 'both',
	push_files: 'both',
	create_branch: 'both',
	fork_repository: 'both',
	// pull-request reads
	get_pull_request: 'both',
	get_pull_request_comments: 'both',
	get_pull_request_files: 'both',
	get_pull_request_reviews: 'both',
	list_pull_requests: 'both',
	get_pull_request_status: 'both',
	// contents / metadata reads
	get_file_contents: 'both',
	list_commits: 'both',
	search_code: 'none',
	search_repositories: 'none',
	search_users: 'none',
})

/**
 * Extract the `owner/repo` hint from a `tools/call` arguments object. The
 * `@modelcontextprotocol/server-github` tool schema uses `owner` + `repo` as
 * top-level args for every repo-scoped call. Returns `undefined` when either
 * piece is missing or malformed — the mint call then falls back to a
 * permissions-only-narrowed token (repositories unbounded).
 *
 * Validation is intentionally strict: bad values pass through as `undefined`
 * rather than propagating a broken query string that would 400 the mint route.
 */
export function extractRepoFromArgs(args) {
	if (!args || typeof args !== 'object') return undefined
	const owner = args.owner
	const repo = args.repo
	if (typeof owner !== 'string' || typeof repo !== 'string') return undefined
	if (!REPO_NAME_RE.test(owner) || !REPO_NAME_RE.test(repo)) return undefined
	return `${owner}/${repo}`
}

/**
 * Build the mint URL. `apiBaseUrl` is the Maskin API base (e.g.
 * `https://api.maskin.io` or `http://host.docker.internal:3000` in local dev),
 * `integrationId` is the workspace's GitHub integration UUID, `toolName` is
 * the MCP tool name (without the `mcp__…__` prefix), and `repo` is optional
 * `owner/repo` narrowing.
 *
 * `URL` + `URLSearchParams` handle the escaping — encoding `/` in the repo
 * segment survives the `URLSearchParams` round-trip because Hono's route
 * regex accepts both `owner/repo` and `repo` forms.
 */
export function buildMintUrl({ apiBaseUrl, integrationId, toolName, repo }) {
	if (!apiBaseUrl) throw new Error('MASKIN_API_URL is required')
	if (!integrationId) throw new Error('GITHUB_INTEGRATION_ID is required')
	if (!toolName) throw new Error('toolName is required')
	const url = new URL(
		`/api/integrations/${encodeURIComponent(integrationId)}/github-token`,
		apiBaseUrl,
	)
	url.searchParams.set('tool', toolName)
	if (repo) url.searchParams.set('repo', repo)
	return url.toString()
}

/**
 * MCP tools/list response shape. The proxy answers `tools/list` locally
 * (without spawning the upstream server) so a listing call doesn't pay the
 * mint + spawn round-trip. The returned schema is intentionally sparse — a
 * placeholder description that points callers at the upstream server for the
 * detailed argument shapes. Claude Code renders the `description` to the
 * model verbatim, so we keep it truthful and short.
 */
export function buildToolsListResponse() {
	return {
		tools: Object.keys(KNOWN_TOOLS).map((name) => ({
			name,
			description:
				'GitHub tool proxied to @modelcontextprotocol/server-github with a per-call ' +
				"installation token narrowed by tool + repo. See the upstream server's docs for " +
				'argument details.',
			inputSchema: {
				type: 'object',
				properties: {
					owner: { type: 'string', description: 'Repository owner (org or user).' },
					repo: { type: 'string', description: 'Repository name (no owner prefix).' },
				},
				additionalProperties: true,
			},
		})),
	}
}

/**
 * MCP initialize response. Advertises the same server info so downstream
 * tooling that inspects it sees a recognisable identity, plus `tools`
 * capability. Protocol version is echoed from the client (falling back to
 * the well-known 2024-11-05 date if the client omits it).
 */
export function buildInitializeResponse(clientProtocolVersion) {
	return {
		protocolVersion: clientProtocolVersion || '2024-11-05',
		capabilities: { tools: {} },
		serverInfo: {
			name: 'maskin-github-mcp-proxy',
			version: '0.1.0',
		},
	}
}

/**
 * Parse a batch of MCP JSON-RPC lines received on stdin. The stdio transport
 * is newline-delimited JSON — one message per line. Blank lines are ignored;
 * malformed lines are surfaced to the caller so it can log + drop them.
 */
export function parseJsonRpcLines(buffer) {
	const messages = []
	const errors = []
	for (const line of buffer.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			messages.push(JSON.parse(trimmed))
		} catch (err) {
			errors.push({ line: trimmed, error: err instanceof Error ? err.message : String(err) })
		}
	}
	return { messages, errors }
}

/**
 * Format an MCP JSON-RPC response line. The stdio transport requires exactly
 * one JSON object per line, terminated by `\n`. `id` is echoed from the
 * request; `result` OR `error` is set, never both.
 */
export function formatJsonRpcResult(id, result) {
	return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`
}

export function formatJsonRpcError(id, code, message, data) {
	const error = data === undefined ? { code, message } : { code, message, data }
	return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`
}
