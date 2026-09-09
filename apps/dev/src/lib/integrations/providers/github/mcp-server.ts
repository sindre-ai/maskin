import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { getGithubToken, remintGithubToken } from './mcp-token-mint'

/**
 * Maskin-owned MCP server for GitHub, served over Streamable HTTP at
 * `/api/integrations/github/mcp/:integrationId`. Replaces the third-party
 * `@modelcontextprotocol/server-github` stdio subprocess that was auto-injected
 * into every session's MCP config by session-manager. See parent insight
 * https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/652d30a9-8476-48ec-89ca-f6b2826f23fc
 * for why the swap is needed: the upstream subprocess baked a GitHub App
 * installation token into its env at spawn time, and that token expired
 * exactly one hour later with no in-process way to refresh — every session
 * outliving that mark silently 401'd on Code Reviewer's late verdict posts.
 *
 * Auth behaviour: each MCP tool call routes through `githubApiCall`, which
 * fetches api.github.com with a cached token (see mcp-token-mint.ts, 50-minute
 * soft TTL inside GitHub's 60-minute hard TTL). On HTTP 401 the token is
 * invalidated, freshly minted via `TokenManager.getValidToken` (which calls
 * `mintInstallationTokenWithRecovery` for the github provider), and the same
 * call is retried exactly once. A second 401 surfaces the terminal error
 * `GITHUB_REMINT_UNRESOLVED_401` so the agent can distinguish a stale-token
 * blip from a scope / permissions bug. Anything else passes through.
 *
 * Tool surface: mirrors the tools the agent CLIs (Claude Code, Codex) actually
 * invoke through `mcp__github-<owner>__*`. Not a full REST mirror — additions
 * are on request. Every tool returns the raw GitHub response body as JSON
 * text, same shape the upstream server used, so no prompt-side re-training is
 * needed.
 */

const GITHUB_API = 'https://api.github.com'

export interface GithubMcpContext {
	db: Database
	integrationId: string
	workspaceId: string
	actorId: string
}

export class GithubApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
		public readonly body?: string,
	) {
		super(message)
		this.name = 'GithubApiError'
	}
}

type FetchOptions = {
	method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
	body?: unknown
	query?: Record<string, string | number | boolean | undefined>
}

async function githubApiCall(
	ctx: GithubMcpContext,
	path: string,
	opts: FetchOptions = {},
): Promise<{ status: number; data: unknown }> {
	const url = new URL(`${GITHUB_API}${path}`)
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) {
			if (v !== undefined) url.searchParams.set(k, String(v))
		}
	}

	const doFetch = async (token: string) => {
		const init: RequestInit = {
			method: opts.method ?? 'GET',
			headers: {
				Authorization: `token ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				'User-Agent': 'maskin-mcp-github',
				...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
			},
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
		}
		return fetch(url.toString(), init)
	}

	let token = await getGithubToken(ctx.db, ctx.integrationId)
	let response = await doFetch(token)

	if (response.status === 401) {
		// Token freshness recovery: re-mint once and retry the exact same call.
		// A second 401 on the retry means the grant is genuinely wrong (scope /
		// permissions bug), not a stale token — surface it as terminal so the
		// caller can distinguish freshness from a scopes issue.
		token = await remintGithubToken(ctx.db, ctx.integrationId)
		response = await doFetch(token)
		if (response.status === 401) {
			const body = await response.text().catch(() => '')
			throw new GithubApiError(
				401,
				'GITHUB_REMINT_UNRESOLVED_401: token re-mint did not resolve 401 - check scopes/permissions',
				body,
			)
		}
	}

	if (response.status === 204) {
		return { status: 204, data: null }
	}

	const text = await response.text()
	if (!response.ok) {
		throw new GithubApiError(response.status, `GitHub API ${response.status}`, text)
	}
	try {
		return { status: response.status, data: text ? JSON.parse(text) : null }
	} catch {
		return { status: response.status, data: text }
	}
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function toolError(operation: string, err: unknown) {
	if (err instanceof GithubApiError) {
		logger.warn('GitHub MCP tool returned an API error', {
			operation,
			status: err.status,
			bodySnippet: err.body?.slice(0, 200),
		})
		return {
			isError: true as const,
			content: [
				{
					type: 'text' as const,
					text: err.body ? `${err.message}: ${err.body}` : err.message,
				},
			],
		}
	}
	logger.error('GitHub MCP tool unexpected error', {
		operation,
		error: err instanceof Error ? err.message : String(err),
	})
	return {
		isError: true as const,
		content: [
			{
				type: 'text' as const,
				text: `Unexpected error in ${operation}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	}
}

function wrap<A extends Record<string, unknown>>(
	operation: string,
	handler: (args: A) => Promise<{ status: number; data: unknown }>,
) {
	return async (args: A) => {
		try {
			const { data } = await handler(args)
			return jsonResult(data)
		} catch (err) {
			return toolError(operation, err)
		}
	}
}

export function createGithubMcpServer(ctx: GithubMcpContext): McpServer {
	const server = new McpServer({ name: 'maskin-github', version: '0.1.0' })

	// ── Reads ────────────────────────────────────────────────────────────────

	server.registerTool(
		'get_file_contents',
		{
			description:
				'Get the contents of a file or directory from a GitHub repository. Same shape as @modelcontextprotocol/server-github: pass owner, repo, path, and optionally a branch or ref. Returns the raw GitHub REST response (base64-encoded content for files, an array for directories).',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				path: z.string(),
				branch: z.string().optional(),
			},
		},
		wrap('get_file_contents', ({ owner, repo, path, branch }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
				query: { ref: branch },
			}),
		),
	)

	server.registerTool(
		'search_code',
		{
			description: 'Search for code across GitHub repositories using the GitHub Search API syntax.',
			inputSchema: {
				q: z.string().min(1),
				page: z.number().int().positive().optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
		},
		wrap('search_code', ({ q, page, per_page }) =>
			githubApiCall(ctx, '/search/code', { query: { q, page, per_page } }),
		),
	)

	server.registerTool(
		'search_repositories',
		{
			description: 'Search for GitHub repositories.',
			inputSchema: {
				query: z.string().min(1),
				page: z.number().int().positive().optional(),
				perPage: z.number().int().min(1).max(100).optional(),
			},
		},
		wrap('search_repositories', ({ query, page, perPage }) =>
			githubApiCall(ctx, '/search/repositories', { query: { q: query, page, per_page: perPage } }),
		),
	)

	server.registerTool(
		'search_issues',
		{
			description: 'Search GitHub issues and pull requests using the Search API.',
			inputSchema: {
				q: z.string().min(1),
				page: z.number().int().positive().optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
		},
		wrap('search_issues', ({ q, page, per_page }) =>
			githubApiCall(ctx, '/search/issues', { query: { q, page, per_page } }),
		),
	)

	server.registerTool(
		'list_commits',
		{
			description: 'List commits on a branch or the default branch of a GitHub repository.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				sha: z.string().optional(),
				page: z.number().int().positive().optional(),
				perPage: z.number().int().min(1).max(100).optional(),
			},
		},
		wrap('list_commits', ({ owner, repo, sha, page, perPage }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/commits`, {
				query: { sha, page, per_page: perPage },
			}),
		),
	)

	// ── Issues ───────────────────────────────────────────────────────────────

	server.registerTool(
		'get_issue',
		{
			description: 'Get a single GitHub issue or pull request by number.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				issue_number: z.number().int().positive(),
			},
		},
		wrap('get_issue', ({ owner, repo, issue_number }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/issues/${issue_number}`),
		),
	)

	server.registerTool(
		'list_issues',
		{
			description: 'List issues in a GitHub repository, optionally filtered by state and labels.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				state: z.enum(['open', 'closed', 'all']).optional(),
				labels: z.string().optional(),
				page: z.number().int().positive().optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
		},
		wrap('list_issues', ({ owner, repo, state, labels, page, per_page }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/issues`, {
				query: { state, labels, page, per_page },
			}),
		),
	)

	server.registerTool(
		'create_issue',
		{
			description: 'Open a new issue on a GitHub repository.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				title: z.string().min(1),
				body: z.string().optional(),
				labels: z.array(z.string()).optional(),
				assignees: z.array(z.string()).optional(),
			},
		},
		wrap('create_issue', ({ owner, repo, ...body }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/issues`, { method: 'POST', body }),
		),
	)

	server.registerTool(
		'update_issue',
		{
			description: 'Update an existing GitHub issue.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				issue_number: z.number().int().positive(),
				title: z.string().optional(),
				body: z.string().optional(),
				state: z.enum(['open', 'closed']).optional(),
				labels: z.array(z.string()).optional(),
				assignees: z.array(z.string()).optional(),
			},
		},
		wrap('update_issue', ({ owner, repo, issue_number, ...body }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/issues/${issue_number}`, {
				method: 'PATCH',
				body,
			}),
		),
	)

	server.registerTool(
		'add_issue_comment',
		{
			description: 'Add a comment to a GitHub issue or pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				issue_number: z.number().int().positive(),
				body: z.string().min(1),
			},
		},
		wrap('add_issue_comment', ({ owner, repo, issue_number, body }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
				method: 'POST',
				body: { body },
			}),
		),
	)

	// ── Pull requests ────────────────────────────────────────────────────────

	server.registerTool(
		'get_pull_request',
		{
			description: 'Get details of a specific pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
			},
		},
		wrap('get_pull_request', ({ owner, repo, pull_number }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}`),
		),
	)

	server.registerTool(
		'list_pull_requests',
		{
			description: 'List pull requests in a GitHub repository.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				state: z.enum(['open', 'closed', 'all']).optional(),
				head: z.string().optional(),
				base: z.string().optional(),
				page: z.number().int().positive().optional(),
				per_page: z.number().int().min(1).max(100).optional(),
			},
		},
		wrap('list_pull_requests', ({ owner, repo, state, head, base, page, per_page }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls`, {
				query: { state, head, base, page, per_page },
			}),
		),
	)

	server.registerTool(
		'create_pull_request',
		{
			description: 'Open a new pull request on a GitHub repository.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				title: z.string().min(1),
				head: z.string().min(1),
				base: z.string().min(1),
				body: z.string().optional(),
				draft: z.boolean().optional(),
				maintainer_can_modify: z.boolean().optional(),
			},
		},
		wrap('create_pull_request', ({ owner, repo, ...body }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls`, { method: 'POST', body }),
		),
	)

	server.registerTool(
		'get_pull_request_files',
		{
			description: 'List the files changed in a pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
			},
		},
		wrap('get_pull_request_files', ({ owner, repo, pull_number }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}/files`),
		),
	)

	server.registerTool(
		'get_pull_request_comments',
		{
			description: 'Get the review comments on a pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
			},
		},
		wrap('get_pull_request_comments', ({ owner, repo, pull_number }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}/comments`),
		),
	)

	server.registerTool(
		'get_pull_request_reviews',
		{
			description: 'Get the reviews on a pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
			},
		},
		wrap('get_pull_request_reviews', ({ owner, repo, pull_number }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`),
		),
	)

	server.registerTool(
		'get_pull_request_status',
		{
			description: 'Get the combined status for the head commit of a pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
			},
		},
		wrap('get_pull_request_status', async ({ owner, repo, pull_number }) => {
			// Combined status is keyed on the head SHA, so first fetch the PR to
			// pick out `head.sha` and then hit /commits/{sha}/status. Mirrors the
			// upstream server's two-step, so tool callers see the same envelope.
			const pr = (await githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}`))
				.data as { head?: { sha?: string } } | null
			const sha = pr?.head?.sha
			if (!sha) {
				return { status: 200, data: { state: 'unknown', statuses: [] } }
			}
			return githubApiCall(ctx, `/repos/${owner}/${repo}/commits/${sha}/status`)
		}),
	)

	server.registerTool(
		'create_pull_request_review',
		{
			description: 'Submit a review on a pull request.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
				body: z.string().optional(),
				event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
				commit_id: z.string().optional(),
				comments: z
					.array(
						z.object({
							path: z.string(),
							position: z.number().int().optional(),
							line: z.number().int().optional(),
							body: z.string(),
						}),
					)
					.optional(),
			},
		},
		wrap('create_pull_request_review', ({ owner, repo, pull_number, ...body }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, {
				method: 'POST',
				body,
			}),
		),
	)

	server.registerTool(
		'merge_pull_request',
		{
			description: 'Merge a pull request into its base branch.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
				commit_title: z.string().optional(),
				commit_message: z.string().optional(),
				merge_method: z.enum(['merge', 'squash', 'rebase']).optional(),
				sha: z.string().optional(),
			},
		},
		wrap('merge_pull_request', ({ owner, repo, pull_number, ...body }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
				method: 'PUT',
				body,
			}),
		),
	)

	server.registerTool(
		'update_pull_request_branch',
		{
			description: 'Update a pull request branch with the latest commit from the base branch.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				pull_number: z.number().int().positive(),
				expected_head_sha: z.string().optional(),
			},
		},
		wrap('update_pull_request_branch', ({ owner, repo, pull_number, expected_head_sha }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/pulls/${pull_number}/update-branch`, {
				method: 'PUT',
				body: expected_head_sha ? { expected_head_sha } : {},
			}),
		),
	)

	// ── Writes on refs / contents ────────────────────────────────────────────

	server.registerTool(
		'create_branch',
		{
			description:
				'Create a new branch in a GitHub repository. When from_branch is omitted the repository default branch is used.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				branch: z.string().min(1),
				from_branch: z.string().optional(),
			},
		},
		wrap('create_branch', async ({ owner, repo, branch, from_branch }) => {
			let sourceBranch = from_branch
			if (!sourceBranch) {
				const repoInfo = (await githubApiCall(ctx, `/repos/${owner}/${repo}`)).data as {
					default_branch?: string
				} | null
				sourceBranch = repoInfo?.default_branch ?? 'main'
			}
			const ref = (
				await githubApiCall(ctx, `/repos/${owner}/${repo}/git/ref/heads/${sourceBranch}`)
			).data as { object?: { sha?: string } } | null
			const sha = ref?.object?.sha
			if (!sha) {
				throw new GithubApiError(500, `Could not resolve head sha for ${sourceBranch}`)
			}
			return githubApiCall(ctx, `/repos/${owner}/${repo}/git/refs`, {
				method: 'POST',
				body: { ref: `refs/heads/${branch}`, sha },
			})
		}),
	)

	server.registerTool(
		'create_or_update_file',
		{
			description:
				'Create a new file or update an existing file in a GitHub repository. Content should be plain UTF-8 text; it is base64-encoded before the API call. To update, provide the existing blob sha.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				path: z.string().min(1),
				content: z.string(),
				message: z.string().min(1),
				branch: z.string().min(1),
				sha: z.string().optional(),
			},
		},
		wrap('create_or_update_file', ({ owner, repo, path, content, message, branch, sha }) =>
			githubApiCall(ctx, `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
				method: 'PUT',
				body: {
					message,
					content: Buffer.from(content, 'utf8').toString('base64'),
					branch,
					...(sha ? { sha } : {}),
				},
			}),
		),
	)

	server.registerTool(
		'push_files',
		{
			description:
				'Push multiple files to a GitHub repository in a single commit. Mirrors the upstream server-github tool: creates one tree containing every file, one commit on top of the branch head, and fast-forwards the branch ref to that commit.',
			inputSchema: {
				owner: z.string().min(1),
				repo: z.string().min(1),
				branch: z.string().min(1),
				message: z.string().min(1),
				files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1),
			},
		},
		wrap('push_files', async ({ owner, repo, branch, message, files }) => {
			const ref = (await githubApiCall(ctx, `/repos/${owner}/${repo}/git/ref/heads/${branch}`))
				.data as { object?: { sha?: string } } | null
			const parentSha = ref?.object?.sha
			if (!parentSha) {
				throw new GithubApiError(500, `Could not resolve head sha for ${branch}`)
			}
			const parentCommit = (
				await githubApiCall(ctx, `/repos/${owner}/${repo}/git/commits/${parentSha}`)
			).data as { tree?: { sha?: string } } | null
			const baseTree = parentCommit?.tree?.sha
			if (!baseTree) {
				throw new GithubApiError(500, `Could not resolve base tree for ${parentSha}`)
			}
			const blobs = await Promise.all(
				files.map(async (f) => {
					const created = (
						await githubApiCall(ctx, `/repos/${owner}/${repo}/git/blobs`, {
							method: 'POST',
							body: {
								content: Buffer.from(f.content, 'utf8').toString('base64'),
								encoding: 'base64',
							},
						})
					).data as { sha?: string } | null
					if (!created?.sha) throw new GithubApiError(500, `Failed to create blob for ${f.path}`)
					return { path: f.path, mode: '100644' as const, type: 'blob' as const, sha: created.sha }
				}),
			)
			const newTree = (
				await githubApiCall(ctx, `/repos/${owner}/${repo}/git/trees`, {
					method: 'POST',
					body: { base_tree: baseTree, tree: blobs },
				})
			).data as { sha?: string } | null
			if (!newTree?.sha) throw new GithubApiError(500, 'Failed to create tree')
			const newCommit = (
				await githubApiCall(ctx, `/repos/${owner}/${repo}/git/commits`, {
					method: 'POST',
					body: { message, tree: newTree.sha, parents: [parentSha] },
				})
			).data as { sha?: string } | null
			if (!newCommit?.sha) throw new GithubApiError(500, 'Failed to create commit')
			return githubApiCall(ctx, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
				method: 'PATCH',
				body: { sha: newCommit.sha, force: false },
			})
		}),
	)

	return server
}
