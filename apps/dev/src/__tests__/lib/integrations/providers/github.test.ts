import { describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/github/config'
import { githubAuth } from '../../../../lib/integrations/providers/github/auth'
import { githubEventNormalizer } from '../../../../lib/integrations/providers/github/webhooks'

describe('GitHub provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('github')
		expect(config.displayName).toBe('GitHub')
	})

	it('uses oauth2_custom auth type', () => {
		expect(config.auth.type).toBe('oauth2_custom')
	})

	it('has webhook config with hmac-sha256', () => {
		const wh = config.webhook
		expect(wh).toBeDefined()
		expect(wh).not.toHaveProperty('type')
		if ('signatureScheme' in wh!) {
			expect(wh.signatureScheme).toBe('hmac-sha256')
			expect(wh.signatureHeader).toBe('x-hub-signature-256')
			expect(wh.signaturePrefix).toBe('sha256=')
			expect(wh.secretEnv).toBe('GITHUB_APP_WEBHOOK_SECRET')
			expect(wh.eventTypeHeader).toBe('x-github-event')
		}
	})

	it('defines event types', () => {
		expect(config.events?.definitions).toBeDefined()
		const types = config.events!.definitions.map((d) => d.entityType)
		expect(types).toContain('github.pull_request')
		expect(types).toContain('github.issue')
		expect(types).toContain('github.push')
		expect(types).toContain('github.review')
	})

	it('has MCP config', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp!.command).toBe('npx')
		expect(config.mcp!.envKey).toBe('GITHUB_PERSONAL_ACCESS_TOKEN')
	})
})

describe('githubAuth', () => {
	describe('getInstallUrl', () => {
		it('returns GitHub App installation URL with state', () => {
			const url = githubAuth.getInstallUrl('my-state')
			expect(url).toContain('https://github.com/apps/')
			expect(url).toContain('/installations/new')
			expect(url).toContain('state=my-state')
		})

		it('URL-encodes the state parameter', () => {
			const url = githubAuth.getInstallUrl('state with spaces&special=chars')
			expect(url).toContain(encodeURIComponent('state with spaces&special=chars'))
		})
	})

	describe('handleCallback', () => {
		it('extracts installation_id from params', async () => {
			const result = await githubAuth.handleCallback({ installation_id: 'inst-42' })
			expect(result).toEqual({ installation_id: 'inst-42' })
		})

		it('throws when installation_id is missing', async () => {
			await expect(githubAuth.handleCallback({})).rejects.toThrow(
				'Missing installation_id in callback',
			)
		})
	})
})

describe('githubEventNormalizer', () => {
	function makePayload(overrides?: Record<string, unknown>) {
		return {
			installation: { id: 12345 },
			repository: { full_name: 'owner/repo' },
			sender: { login: 'user' },
			action: 'opened',
			...overrides,
		}
	}

	it('normalizes pull_request event', () => {
		const payload = makePayload({
			action: 'opened',
			pull_request: {
				number: 42,
				title: 'Add feature',
				html_url: 'https://github.com/owner/repo/pull/42',
				diff_url: 'https://github.com/owner/repo/pull/42.diff',
				head: { sha: 'abc123' },
				base: { ref: 'main' },
			},
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)

		expect(result).not.toBeNull()
		expect(result!.entityType).toBe('github.pull_request')
		expect(result!.action).toBe('opened')
		expect(result!.installationId).toBe('12345')
		expect(result!.data.pr_number).toBe(42)
		expect(result!.data.pr_title).toBe('Add feature')
		expect(result!.data.pr_head_sha).toBe('abc123')
		expect(result!.data.pr_base_branch).toBe('main')
	})

	it('maps closed+merged pull_request to merged action', () => {
		const payload = makePayload({
			action: 'closed',
			pull_request: { merged: true, number: 1, title: 'PR', head: {}, base: {} },
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)
		expect(result!.action).toBe('merged')
	})

	it('maps closed (not merged) pull_request to closed action', () => {
		const payload = makePayload({
			action: 'closed',
			pull_request: { merged: false, number: 1, title: 'PR', head: {}, base: {} },
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)
		expect(result!.action).toBe('closed')
	})

	it('normalizes push event', () => {
		const payload = makePayload({
			ref: 'refs/heads/main',
			commits: [{ id: '1' }, { id: '2' }],
			head_commit: { message: 'Fix bug' },
		})
		const headers = { 'x-github-event': 'push' }

		const result = githubEventNormalizer(payload, headers)

		expect(result!.entityType).toBe('github.push')
		expect(result!.action).toBe('pushed')
		expect(result!.data.ref).toBe('refs/heads/main')
		expect(result!.data.commits_count).toBe(2)
		expect(result!.data.head_commit).toBe('Fix bug')
	})

	it('normalizes issues event', () => {
		const payload = makePayload({
			action: 'opened',
			issue: {
				number: 10,
				title: 'Bug report',
				html_url: 'https://github.com/owner/repo/issues/10',
			},
		})
		const headers = { 'x-github-event': 'issues' }

		const result = githubEventNormalizer(payload, headers)

		expect(result!.entityType).toBe('github.issue')
		expect(result!.action).toBe('opened')
		expect(result!.data.issue_number).toBe(10)
		expect(result!.data.issue_title).toBe('Bug report')
	})

	it('normalizes pull_request_review event', () => {
		const payload = makePayload({
			action: 'submitted',
			pull_request: { number: 5, title: 'PR', head: {}, base: {} },
			review: { state: 'approved', body: 'LGTM' },
		})
		const headers = { 'x-github-event': 'pull_request_review' }

		const result = githubEventNormalizer(payload, headers)

		expect(result!.entityType).toBe('github.review')
		expect(result!.action).toBe('submitted')
		expect(result!.data.review_state).toBe('approved')
		expect(result!.data.review_body).toBe('LGTM')
	})

	it('returns null for unknown event type', () => {
		const payload = makePayload()
		const headers = { 'x-github-event': 'deployment' }

		expect(githubEventNormalizer(payload, headers)).toBeNull()
	})

	it('returns null when x-github-event header is missing', () => {
		const payload = makePayload()
		expect(githubEventNormalizer(payload, {})).toBeNull()
	})

	it('returns null when installation is missing', () => {
		const payload = { action: 'opened', repository: { full_name: 'a/b' }, sender: { login: 'u' } }
		const headers = { 'x-github-event': 'push' }

		expect(githubEventNormalizer(payload, headers)).toBeNull()
	})

	it('uses action from body or falls back to unknown', () => {
		const payload = makePayload()
		delete (payload as Record<string, unknown>).action
		const headers = { 'x-github-event': 'issues' }

		const result = githubEventNormalizer(payload, headers)
		expect(result!.action).toBe('unknown')
	})
})
