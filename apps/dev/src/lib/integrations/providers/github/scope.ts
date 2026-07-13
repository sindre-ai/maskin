/**
 * Per-request installation-token scope derivation.
 *
 * A leaked installation token's blast radius is bounded by the `repositories`
 * and `permissions` it was minted with. We narrow both from the current MCP
 * tool call: the `repositories` array holds the single repo the call targets,
 * and the `permissions` object holds only the scopes that specific tool needs.
 *
 * The mapping stays within the App's ceiling (see
 * `.github/agent-app/manifest.json`): `contents: write`, `pull_requests: write`,
 * `checks: read`, `metadata: read`. Tools that would need a scope outside the
 * ceiling must be added to both the manifest AND this mapping — never silently
 * fall back to the full install scope.
 */
export type Permission = 'read' | 'write'
export type PermissionSet = Record<string, Permission>

export interface InstallationScope {
	/** Repository names (no owner prefix — GitHub's `POST /access_tokens` API. */
	repositories?: string[]
	/** GitHub App permission set — read/write per resource. */
	permissions?: PermissionSet
}

export interface ScopeInput {
	/** MCP tool name (without the `mcp__<server>__` prefix). Also accepts `git` for credential-helper invocations. */
	toolName: string
	/** `owner/repo` or just `repo`. Owner prefix is stripped — GitHub's API expects the repo name only. */
	repo?: string
}

export class UnmappedToolError extends Error {
	constructor(readonly toolName: string) {
		super(
			`GitHub tool "${toolName}" is not in the scope mapping. Extend TOOL_PERMISSIONS in apps/dev/src/lib/integrations/providers/github/scope.ts. If the tool needs a permission outside the App's ceiling, extend .github/agent-app/manifest.json first — never silently fall back to a full-install token.`,
		)
		this.name = 'UnmappedToolError'
	}
}

/**
 * MCP-tool → minimum-permission-set. Tool names match the
 * `@modelcontextprotocol/server-github` server's tool inventory (see
 * https://github.com/modelcontextprotocol/servers/tree/main/src/github), with
 * `git` reserved for credential-helper invocations (git push/fetch/clone).
 *
 * Stays inside T1's App manifest ceiling. Tools that would need `issues`,
 * `actions`, `workflows`, or `administration` are deliberately absent so the
 * hook throws {@link UnmappedToolError} rather than mint a token the App
 * doesn't even have.
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, PermissionSet>> = Object.freeze({
	// ── Write: pull requests ──────────────────────────────────────
	create_pull_request: { pull_requests: 'write', metadata: 'read' },
	create_pull_request_review: { pull_requests: 'write', metadata: 'read' },
	update_pull_request_branch: { pull_requests: 'write', contents: 'write', metadata: 'read' },
	// Merging writes to the branch head as well as closing the PR.
	merge_pull_request: { pull_requests: 'write', contents: 'write', metadata: 'read' },

	// ── Write: contents ───────────────────────────────────────────
	create_or_update_file: { contents: 'write', metadata: 'read' },
	push_files: { contents: 'write', metadata: 'read' },
	create_branch: { contents: 'write', metadata: 'read' },
	// Fork endpoint writes into the actor's namespace; scoped to the source repo here.
	fork_repository: { contents: 'write', metadata: 'read' },

	// ── Read: pull requests ───────────────────────────────────────
	get_pull_request: { pull_requests: 'read', metadata: 'read' },
	get_pull_request_comments: { pull_requests: 'read', metadata: 'read' },
	get_pull_request_files: { pull_requests: 'read', metadata: 'read' },
	get_pull_request_reviews: { pull_requests: 'read', metadata: 'read' },
	list_pull_requests: { pull_requests: 'read', metadata: 'read' },
	// Status pulls in check runs alongside the PR row.
	get_pull_request_status: { pull_requests: 'read', checks: 'read', metadata: 'read' },

	// ── Read: contents / metadata ────────────────────────────────
	get_file_contents: { contents: 'read', metadata: 'read' },
	list_commits: { contents: 'read', metadata: 'read' },
	search_code: { contents: 'read', metadata: 'read' },
	search_repositories: { metadata: 'read' },
	search_users: { metadata: 'read' },

	// ── Git operations via the credential helper ─────────────────
	// `docker/agent-base/github-credential-helper.sh` hits the token route once
	// per git invocation. It doesn't know push vs. fetch, so grant the minimum
	// superset needed by the four identities' shipping flow (push to a branch,
	// which is contents:write; and pull-request-review side-effects covered by
	// the update/merge tools above).
	git: { contents: 'write', metadata: 'read' },
})

const REPO_NAME_RE = /^[A-Za-z0-9_.-]+$/
const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Normalize a caller-supplied repo hint to a bare repo name. GitHub's
 * `POST /app/installations/:id/access_tokens` endpoint expects
 * `repositories: ['repo-name']` — no owner prefix — because the installation
 * itself already binds an owner. Accepts both `owner/repo` and `repo`.
 */
export function normalizeRepo(input: string): string {
	if (OWNER_REPO_RE.test(input)) {
		const bare = input.split('/', 2)[1]
		if (bare) return bare
	}
	if (REPO_NAME_RE.test(input)) return input
	throw new Error(
		`Invalid repo "${input}" — expected "owner/repo" or "repo" with only [A-Za-z0-9_.-]`,
	)
}

/**
 * Derive the installation-token scope for one MCP tool call.
 *
 * - `permissions` is looked up from {@link TOOL_PERMISSIONS}. Unknown tool ⇒
 *   {@link UnmappedToolError} — never a silent fallback to full-install scope.
 * - `repositories` is set to `[repo]` when the caller supplies one, so a leaked
 *   token can't reach any other repo in the installation. Omitted when the
 *   caller doesn't scope by repo (e.g. cross-repo search); the token is still
 *   narrowed by permissions.
 */
export function deriveScope({ toolName, repo }: ScopeInput): InstallationScope {
	const permissions = TOOL_PERMISSIONS[toolName]
	if (!permissions) {
		throw new UnmappedToolError(toolName)
	}
	const scope: InstallationScope = { permissions: { ...permissions } }
	if (repo) {
		scope.repositories = [normalizeRepo(repo)]
	}
	return scope
}
