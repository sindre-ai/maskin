import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getValidTokenMock } = vi.hoisted(() => ({
	getValidTokenMock: vi.fn(),
}))

vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))

vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn(() => ({ config: { name: 'github' } })),
}))

import { createGithubMcpServer } from '../../../../lib/integrations/providers/github/mcp-server'
import {
	_resetGithubTokenCacheForTests,
	getRemintCountForTests,
} from '../../../../lib/integrations/providers/github/mcp-token-mint'

const ctx = {
	db: {} as Database,
	integrationId: 'int-github-abc',
	workspaceId: 'ws-1',
	actorId: 'actor-1',
}

function tools(server: ReturnType<typeof createGithubMcpServer>) {
	return (
		server as unknown as {
			_registeredTools: Record<
				string,
				{
					handler: (
						args: unknown,
						extra: unknown,
					) => Promise<{
						content: Array<{ type: string; text: string }>
						isError?: boolean
					}>
				}
			>
		}
	)._registeredTools
}

async function callTool(name: string, args: Record<string, unknown>) {
	const server = createGithubMcpServer(ctx)
	return tools(server)[name].handler(args, {})
}

beforeEach(() => {
	_resetGithubTokenCacheForTests()
	getValidTokenMock.mockReset()
	vi.restoreAllMocks()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('createGithubMcpServer', () => {
	it('registers the expected tool surface', () => {
		const server = createGithubMcpServer(ctx)
		const names = Object.keys(tools(server)).sort()
		expect(names).toEqual([
			'add_issue_comment',
			'create_branch',
			'create_issue',
			'create_or_update_file',
			'create_pull_request',
			'create_pull_request_review',
			'get_file_contents',
			'get_issue',
			'get_pull_request',
			'get_pull_request_comments',
			'get_pull_request_files',
			'get_pull_request_reviews',
			'get_pull_request_status',
			'list_commits',
			'list_issues',
			'list_pull_requests',
			'merge_pull_request',
			'push_files',
			'search_code',
			'search_issues',
			'search_repositories',
			'update_issue',
			'update_pull_request_branch',
		])
	})

	it('sends the cached token as a token Authorization header on the happy path', async () => {
		getValidTokenMock.mockResolvedValue('ghs_happy_token')
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ number: 42 }), { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const result = await callTool('get_pull_request', {
			owner: 'sindre-ai',
			repo: 'maskin',
			pull_number: 42,
		})

		expect(result.isError).not.toBe(true)
		expect(JSON.parse(result.content[0].text as string)).toEqual({ number: 42 })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit
		expect((init.headers as Record<string, string>).Authorization).toBe('token ghs_happy_token')
	})
})

describe('createGithubMcpServer — 401 retry', () => {
	// Ship criterion from the parent insight:
	//   "Unit test 401 path: mocked 401 → mint called once → retry called once → success."
	// This is that test — plus the second-401 terminal path that surfaces the
	// scope/permissions hint, and the counter tick that lets us watch adoption.

	it('re-mints exactly once on 401 and retries the same call, then succeeds on the second attempt', async () => {
		getValidTokenMock
			.mockResolvedValueOnce('ghs_stale') // initial cache-miss mint
			.mockResolvedValueOnce('ghs_fresh') // re-mint after 401
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('Bad credentials', { status: 401 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ number: 7 }), { status: 200 }))
		vi.stubGlobal('fetch', fetchMock)

		const result = await callTool('get_pull_request', {
			owner: 'sindre-ai',
			repo: 'maskin',
			pull_number: 7,
		})

		expect(result.isError).not.toBe(true)
		expect(JSON.parse(result.content[0].text as string)).toEqual({ number: 7 })

		// Mint called twice: once for initial (cache miss), once for the 401 re-mint.
		expect(getValidTokenMock).toHaveBeenCalledTimes(2)
		// Fetch called twice: original call + retry with the freshly-minted token.
		expect(fetchMock).toHaveBeenCalledTimes(2)

		const firstHeaders = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<
			string,
			string
		>
		const secondHeaders = (fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<
			string,
			string
		>
		expect(firstHeaders.Authorization).toBe('token ghs_stale')
		expect(secondHeaders.Authorization).toBe('token ghs_fresh')

		// Counter ticked exactly once — the observability signal the parent insight
		// requires ("expect >0 within a week; if 0, the shim isn't wired in").
		expect(getRemintCountForTests(ctx.integrationId)).toBe(1)
	})

	it('surfaces GITHUB_REMINT_UNRESOLVED_401 when the retry also returns 401 (scope/permissions bug)', async () => {
		getValidTokenMock.mockResolvedValueOnce('ghs_token_1').mockResolvedValueOnce('ghs_token_2')
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('Bad credentials', { status: 401 }))
			.mockResolvedValueOnce(new Response('Bad credentials', { status: 401 }))
		vi.stubGlobal('fetch', fetchMock)

		const result = await callTool('get_issue', {
			owner: 'sindre-ai',
			repo: 'maskin',
			issue_number: 1,
		})

		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('GITHUB_REMINT_UNRESOLVED_401')
		expect(result.content[0].text).toContain('check scopes/permissions')

		// Only one re-mint happened — no infinite loop trying to salve a genuine
		// scope bug with more token minting.
		expect(getRemintCountForTests(ctx.integrationId)).toBe(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('passes non-401 errors through without a re-mint', async () => {
		getValidTokenMock.mockResolvedValueOnce('ghs_token')
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
		vi.stubGlobal('fetch', fetchMock)

		const result = await callTool('get_file_contents', {
			owner: 'sindre-ai',
			repo: 'maskin',
			path: 'not-there.txt',
		})

		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('GitHub API 404')
		expect(getRemintCountForTests(ctx.integrationId)).toBe(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('reuses the cached token across tool calls on the happy path (no per-call mint latency)', async () => {
		getValidTokenMock.mockResolvedValueOnce('ghs_cached')
		const fetchMock = vi.fn(() =>
			Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
		)
		vi.stubGlobal('fetch', fetchMock)

		await callTool('get_pull_request', { owner: 'a', repo: 'b', pull_number: 1 })
		await callTool('get_pull_request', { owner: 'a', repo: 'b', pull_number: 2 })
		await callTool('get_pull_request', { owner: 'a', repo: 'b', pull_number: 3 })

		// Ship criterion: "No added latency on the happy path." One mint services
		// every subsequent tool call within the cache TTL.
		expect(getValidTokenMock).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})
})
