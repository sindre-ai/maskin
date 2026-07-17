import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO,
	GITHUB_PREFLIGHT_KNOWN_IDENTITIES,
	GITHUB_PREFLIGHT_SLACK_CHANNEL,
	collectGitHubMcpIdentities,
	postGitHubPreflightSlackAlert,
	resolveMcpGitHubToken,
	runGitHubPreflight,
	stripFailedIdentities,
} from '../../../lib/github/preflight'

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'content-type': 'application/json' },
	})
}

function textResponse(text: string, init: ResponseInit): Response {
	return new Response(text, {
		...init,
		headers: { 'content-type': 'text/plain' },
	})
}

describe('runGitHubPreflight', () => {
	it('short-circuits missing tokens without touching the network (protects the 60/hr anonymous bucket)', async () => {
		const fetchImpl = vi.fn()
		const verdicts = await runGitHubPreflight(
			[
				{ name: 'github', token: null },
				{ name: 'github_approver', token: '' },
			],
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		)
		expect(verdicts).toEqual([
			expect.objectContaining({ name: 'github', healthy: false, failureClass: 'missing-token' }),
			expect.objectContaining({
				name: 'github_approver',
				healthy: false,
				failureClass: 'missing-token',
			}),
		])
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('returns healthy when /user succeeds and the write-scope probe creates a blob (HTTP 201)', async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' })
			if (url === `https://api.github.com/repos/${GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO}/git/blobs`)
				return jsonResponse({ sha: 'abc123' }, { status: 201 })
			throw new Error(`unexpected url: ${url}`)
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github', token: 'ghp_ok' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict).toEqual({ name: 'github', healthy: true })
	})

	it('classifies a 401 as 401-unauth and scrubs the token from any echoed body', async () => {
		const token = 'ghp_secretsauce_1234'
		const fetchImpl = vi.fn(async () =>
			textResponse(`bad creds ${token}`, { status: 401, statusText: 'Unauthorized' }),
		)
		const [verdict] = await runGitHubPreflight([{ name: 'github', token }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.healthy).toBe(false)
		expect(verdict.failureClass).toBe('401-unauth')
		expect(verdict.statusSnippet).toContain('HTTP 401')
		expect(verdict.statusSnippet).not.toContain(token)
		expect(verdict.statusSnippet).toContain('<redacted>')
	})

	it('classifies a 403 on the auth read as 403-permission', async () => {
		const fetchImpl = vi.fn(async () => textResponse('forbidden', { status: 403 }))
		const [verdict] = await runGitHubPreflight([{ name: 'github_approver', token: 'ghp_x' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.failureClass).toBe('403-permission')
	})

	it('flags write-scope-denied when the blob-create write attempt itself is rejected with 403', async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' })
			return textResponse('Resource not accessible by integration', { status: 403 })
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github', token: 'ghp_readonly' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.failureClass).toBe('write-scope-denied')
		expect(verdict.statusSnippet).toContain('git/blobs')
		expect(verdict.statusSnippet).toContain('HTTP 403')
	})

	it('never reads permissions.push/pull — a repo reporting push:false is still healthy if the write itself succeeds', async () => {
		// This is the confirmed production root cause: permissions.push/pull on
		// GET /repos and GET /installation/repositories do not reliably reflect
		// what a GitHub App installation token can actually do (see file header).
		// The probe must judge health solely by whether the write succeeds, never
		// by reading a permissions field — so even a response that (if it were
		// read) would say push:false must not affect the verdict.
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' })
			if (url === `https://api.github.com/repos/${GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO}/git/blobs`)
				return jsonResponse({ sha: 'abc123', permissions: { push: false } }, { status: 201 })
			throw new Error(`unexpected url: ${url}`)
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github', token: 'ghp_ok' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.healthy).toBe(true)
	})

	it('skips the /user probe for GitHub App installation tokens (ghs_ prefix) and resolves a repo via the installation’s own accessible repos', async () => {
		const calledUrls: string[] = []
		const fetchImpl = vi.fn(async (url: string) => {
			calledUrls.push(url)
			if (url === 'https://api.github.com/user') {
				// A real installation token 403s here — assert the probe is never
				// even called rather than relying on this branch.
				return textResponse('Resource not accessible by integration', { status: 403 })
			}
			if (url === 'https://api.github.com/installation/repositories?per_page=1') {
				return jsonResponse({ repositories: [{ full_name: 'vaerksted-ai/some-repo' }] })
			}
			if (url === 'https://api.github.com/repos/vaerksted-ai/some-repo/git/blobs') {
				return jsonResponse({ sha: 'abc123' }, { status: 201 })
			}
			throw new Error(`unexpected url: ${url}`)
		})
		const [verdict] = await runGitHubPreflight(
			[{ name: 'github-vaerksted-ai', token: 'ghs_real' }],
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
			},
		)
		expect(verdict).toEqual({ name: 'github-vaerksted-ai', healthy: true })
		expect(calledUrls).not.toContain('https://api.github.com/user')
		expect(calledUrls).toEqual([
			'https://api.github.com/installation/repositories?per_page=1',
			'https://api.github.com/repos/vaerksted-ai/some-repo/git/blobs',
		])
	})

	it('never probes the hardcoded default repo for an installation token, no matter which org it belongs to', async () => {
		// This is the multi-tenant regression case: an installation living in an
		// org other than GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO's owner must still
		// pass, because write-scope is checked against the installation's own
		// repos, never against the fixed default.
		const fetchImpl = vi.fn(async (url: string) => {
			if (url.startsWith(`https://api.github.com/repos/${GITHUB_PREFLIGHT_DEFAULT_PROBE_REPO}`)) {
				throw new Error(
					`must not probe the hardcoded default repo for an installation token: ${url}`,
				)
			}
			if (url === 'https://api.github.com/installation/repositories?per_page=1') {
				return jsonResponse({ repositories: [{ full_name: 'some-other-org/repo' }] })
			}
			return jsonResponse({ sha: 'abc123' }, { status: 201 })
		})
		const [verdict] = await runGitHubPreflight(
			[{ name: 'github-vaerksted-ai', token: 'ghs_real' }],
			{
				fetchImpl: fetchImpl as unknown as typeof fetch,
			},
		)
		expect(verdict.healthy).toBe(true)
	})

	it('flags write-scope-denied when the installation has no accessible repositories', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ repositories: [] }))
		const [verdict] = await runGitHubPreflight([{ name: 'github-sindre-ai', token: 'ghs_real' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.failureClass).toBe('write-scope-denied')
		expect(verdict.statusSnippet).toContain('no accessible repositories')
	})

	it('flags write-scope-denied when the blob-create attempt against the installation’s own resolved repo is rejected', async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/installation/repositories?per_page=1') {
				return jsonResponse({ repositories: [{ full_name: 'sindre-ai/maskin' }] })
			}
			return textResponse('Resource not accessible by integration', { status: 403 })
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github-sindre-ai', token: 'ghs_real' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.failureClass).toBe('write-scope-denied')
		// Names the repo it actually checked — without this, a Slack alert can't
		// distinguish "the tenant's own repo lost write access" from "GitHub
		// surfaced an unexpected repo at index 0" without a live reproduction.
		expect(verdict.statusSnippet).toContain('sindre-ai/maskin')
	})

	it('checks the session’s resolved target repo directly when writeProbeRepo is set, instead of /installation/repositories', async () => {
		const calledUrls: string[] = []
		const fetchImpl = vi.fn(async (url: string) => {
			calledUrls.push(url)
			if (url === 'https://api.github.com/installation/repositories?per_page=1') {
				throw new Error(`must not fall back to /installation/repositories: ${url}`)
			}
			return jsonResponse({ sha: 'abc123' }, { status: 201 })
		})
		const [verdict] = await runGitHubPreflight(
			[{ name: 'github-sindre-ai', token: 'ghs_real', writeProbeRepo: 'sindre-ai/maskin' }],
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		)
		expect(verdict).toEqual({ name: 'github-sindre-ai', healthy: true })
		expect(calledUrls).toEqual(['https://api.github.com/repos/sindre-ai/maskin/git/blobs'])
	})

	it('flags write-scope-denied against the resolved target repo even when the installation has other writable repos', async () => {
		// The precision this buys: an installation can see many repos it can push
		// to while the one specific repo the session will actually push to is
		// unwritable (e.g. archived). Only checking the specific target repo
		// catches this; /installation/repositories would never even be consulted.
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/repos/sindre-ai/archived-repo/git/blobs') {
				return textResponse('Resource not accessible by integration', { status: 403 })
			}
			return jsonResponse({ repositories: [{ full_name: 'sindre-ai/maskin' }] })
		})
		const [verdict] = await runGitHubPreflight(
			[
				{
					name: 'github-sindre-ai',
					token: 'ghs_real',
					writeProbeRepo: 'sindre-ai/archived-repo',
				},
			],
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		)
		expect(verdict.healthy).toBe(false)
		expect(verdict.failureClass).toBe('write-scope-denied')
	})

	it('falls back to /installation/repositories when writeProbeRepo is not set', async () => {
		const calledUrls: string[] = []
		const fetchImpl = vi.fn(async (url: string) => {
			calledUrls.push(url)
			if (url === 'https://api.github.com/installation/repositories?per_page=1') {
				return jsonResponse({ repositories: [{ full_name: 'sindre-ai/maskin' }] })
			}
			return jsonResponse({ sha: 'abc123' }, { status: 201 })
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github-sindre-ai', token: 'ghs_real' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.healthy).toBe(true)
		expect(calledUrls).toEqual([
			'https://api.github.com/installation/repositories?per_page=1',
			'https://api.github.com/repos/sindre-ai/maskin/git/blobs',
		])
	})

	it('classifies a 403 on the installation repo-resolution probe without touching /user', async () => {
		const calledUrls: string[] = []
		const fetchImpl = vi.fn(async (url: string) => {
			calledUrls.push(url)
			return textResponse('Resource not accessible by integration', { status: 403 })
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github-sindre-ai', token: 'ghs_real' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.healthy).toBe(false)
		expect(verdict.failureClass).toBe('403-permission')
		expect(calledUrls).toEqual(['https://api.github.com/installation/repositories?per_page=1'])
	})

	it('returns network-error when fetch throws', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('ECONNRESET')
		})
		const [verdict] = await runGitHubPreflight([{ name: 'github', token: 'ghp_x' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(verdict.failureClass).toBe('network-error')
	})

	it('carries installationId from the identity through to the verdict, healthy or not', async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (url === 'https://api.github.com/installation/repositories?per_page=1') {
				return jsonResponse({ repositories: [{ full_name: 'sindre-ai/maskin' }] })
			}
			return textResponse('Resource not accessible by integration', { status: 403 })
		})
		const [verdict] = await runGitHubPreflight(
			[{ name: 'github-sindre-ai', token: 'ghs_x', installationId: '141870781' }],
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		)
		expect(verdict.failureClass).toBe('write-scope-denied')
		expect(verdict.installationId).toBe('141870781')
	})

	it('probes the write repo passed via options for non-installation (PAT/OAuth) tokens', async () => {
		const seen: string[] = []
		const fetchImpl = vi.fn(async (url: string) => {
			seen.push(url)
			if (url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' })
			return jsonResponse({ sha: 'abc123' }, { status: 201 })
		})
		await runGitHubPreflight([{ name: 'github', token: 'ghp_x' }], {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			writeProbeRepo: 'foo/bar',
		})
		expect(seen).toContain('https://api.github.com/repos/foo/bar/git/blobs')
	})
})

describe('postGitHubPreflightSlackAlert', () => {
	beforeEach(() => vi.restoreAllMocks())

	it('posts one consolidated message with every failing identity and never the raw token', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }))
		await postGitHubPreflightSlackAlert({
			botToken: 'xoxb-1',
			channelId: GITHUB_PREFLIGHT_SLACK_CHANNEL,
			verdicts: [
				{ name: 'github', healthy: false, failureClass: '401-unauth', statusSnippet: 'HTTP 401' },
				{ name: 'github_approver', healthy: true },
				{
					name: 'github-vaerksted-ai',
					healthy: false,
					failureClass: 'missing-token',
					statusSnippet: 'no token attached at launch',
				},
			],
			context: { sessionId: 'sess-1', workspaceId: 'ws-1' },
			options: { fetchImpl: fetchImpl as unknown as typeof fetch },
		})
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const call = fetchImpl.mock.calls[0]
		if (!call) throw new Error('expected one Slack call')
		const [url, init] = call as [string, RequestInit]
		expect(url).toBe('https://slack.com/api/chat.postMessage')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-1')
		const body = JSON.parse(init.body as string) as { channel: string; text: string }
		expect(body.channel).toBe(GITHUB_PREFLIGHT_SLACK_CHANNEL)
		expect(body.text).toContain('2 identities')
		expect(body.text).toContain('github')
		expect(body.text).toContain('github-vaerksted-ai')
		expect(body.text).not.toContain('github_approver')
		expect(body.text).not.toContain('xoxb-1')
	})

	it('includes the installation ID in the alert text when the verdict carries one', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }))
		await postGitHubPreflightSlackAlert({
			botToken: 'xoxb-1',
			channelId: GITHUB_PREFLIGHT_SLACK_CHANNEL,
			verdicts: [
				{
					name: 'github-sindre-ai',
					healthy: false,
					failureClass: 'write-scope-denied',
					statusSnippet: 'permissions.push is false',
					installationId: '141870781',
				},
			],
			context: { sessionId: 'sess-1', workspaceId: 'ws-1' },
			options: { fetchImpl: fetchImpl as unknown as typeof fetch },
		})
		const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined
		if (!call) throw new Error('expected one Slack call')
		const [, init] = call
		const body = JSON.parse(init.body as string) as { text: string }
		expect(body.text).toContain('installation 141870781')
	})

	it('skips posting when every identity is healthy', async () => {
		const fetchImpl = vi.fn()
		await postGitHubPreflightSlackAlert({
			botToken: 'xoxb-1',
			channelId: 'C1',
			verdicts: [{ name: 'github', healthy: true }],
			context: { sessionId: 'sess-1', workspaceId: 'ws-1' },
			options: { fetchImpl: fetchImpl as unknown as typeof fetch },
		})
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('does not throw when Slack itself fails', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('slack down')
		})
		await expect(
			postGitHubPreflightSlackAlert({
				botToken: 'xoxb-1',
				channelId: 'C1',
				verdicts: [
					{ name: 'github', healthy: false, failureClass: '401-unauth', statusSnippet: 'x' },
				],
				context: { sessionId: 'sess-1', workspaceId: 'ws-1' },
				options: { fetchImpl: fetchImpl as unknown as typeof fetch },
			}),
		).resolves.toBeUndefined()
	})
})

describe('resolveMcpGitHubToken', () => {
	it('returns literal tokens unchanged', () => {
		expect(resolveMcpGitHubToken('ghp_literal', {})).toBe('ghp_literal')
	})

	it('resolves `${VAR}` placeholders against envVars', () => {
		expect(
			resolveMcpGitHubToken('${GITHUB_TOKEN_APPROVER}', { GITHUB_TOKEN_APPROVER: 'ghp_a' }),
		).toBe('ghp_a')
	})

	it('returns null when the placeholder is unset — so callers report missing-token', () => {
		expect(resolveMcpGitHubToken('${GITHUB_TOKEN_APPROVER}', {})).toBeNull()
	})

	it('returns null for non-string values', () => {
		expect(resolveMcpGitHubToken(undefined, {})).toBeNull()
		expect(resolveMcpGitHubToken(42, {})).toBeNull()
	})
})

describe('collectGitHubMcpIdentities', () => {
	it('extracts an identity from every entry whose env.GITHUB_PERSONAL_ACCESS_TOKEN is set, across every source', () => {
		const agentTools = {
			github: {
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
			},
			github_approver: {
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN_APPROVER}' },
			},
			slack: {
				env: { SLACK_BOT_TOKEN: '${SLACK_TOKEN}' },
			},
		}
		const autoInjected = {
			'github-sindre-ai': {
				env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghs_literal_sindre' },
			},
			'integration-posthog': {
				env: { POSTHOG_TOKEN: 'phx_x' },
			},
		}
		const identities = collectGitHubMcpIdentities([agentTools, autoInjected], {
			GITHUB_TOKEN: 'ghp_bare',
			GITHUB_TOKEN_APPROVER: 'ghp_approver',
		})
		expect(new Map(identities.map((id) => [id.name, id.token]))).toEqual(
			new Map([
				['github', 'ghp_bare'],
				['github_approver', 'ghp_approver'],
				['github-sindre-ai', 'ghs_literal_sindre'],
			]),
		)
	})

	it('reports unresolved placeholders as null (→ missing-token downstream)', () => {
		const identities = collectGitHubMcpIdentities(
			[{ github_approver: { env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN_APPROVER}' } } }],
			{},
		)
		expect(identities).toEqual([{ name: 'github_approver', token: null }])
	})

	it('gracefully ignores null / undefined sources and non-mcp entries', () => {
		expect(
			collectGitHubMcpIdentities([null, undefined, { plain: 'not-an-object' as unknown }], {}),
		).toEqual([])
	})
})

describe('stripFailedIdentities', () => {
	it('removes only the entries the preflight marked unhealthy', () => {
		const mcp = {
			github: { env: { GITHUB_TOKEN: 'x' } },
			github_approver: { env: { GITHUB_TOKEN: 'y' } },
			slack: {},
		}
		const gated = stripFailedIdentities(mcp, [
			{ name: 'github', healthy: false, failureClass: '401-unauth' },
			{ name: 'github_approver', healthy: true },
		])
		expect(gated).toEqual({
			github_approver: { env: { GITHUB_TOKEN: 'y' } },
			slack: {},
		})
	})

	it('returns the map unchanged when nothing failed', () => {
		const mcp = { github: {} }
		expect(stripFailedIdentities(mcp, [{ name: 'github', healthy: true }])).toBe(mcp)
	})

	it('passes through null / undefined', () => {
		expect(stripFailedIdentities(null, [])).toBeNull()
		expect(stripFailedIdentities(undefined, [])).toBeUndefined()
	})
})

describe('GITHUB_PREFLIGHT_KNOWN_IDENTITIES', () => {
	it('names the four MCP identities the parent bet is provisioning', () => {
		expect([...GITHUB_PREFLIGHT_KNOWN_IDENTITIES]).toEqual([
			'github',
			'github_approver',
			'github-sindre-ai',
			'github-vaerksted-ai',
		])
	})
})
