import { generateKeyPairSync } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	fetchInstallationOwnerLogin,
	githubAuth,
} from '../../../../lib/integrations/providers/github/auth'
import { config } from '../../../../lib/integrations/providers/github/config'
import {
	attributeDeployment,
	githubExtractDeliveryId,
	githubWebhookFanOut,
	githubWebhookPreHandler,
} from '../../../../lib/integrations/providers/github/deployment-status'
import { githubEventNormalizer } from '../../../../lib/integrations/providers/github/webhooks'
import * as deployAttribution from '../../../../services/deploy-attribution'

// Generate an RSA key pair for testing JWT signing
const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

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
		if (wh && 'signatureScheme' in wh) {
			expect(wh.signatureScheme).toBe('hmac-sha256')
			expect(wh.signatureHeader).toBe('x-hub-signature-256')
			expect(wh.signaturePrefix).toBe('sha256=')
			expect(wh.secretEnv).toBe('GITHUB_APP_WEBHOOK_SECRET')
			expect(wh.eventTypeHeader).toBe('x-github-event')
		}
	})

	it('defines event types', () => {
		expect(config.events?.definitions).toBeDefined()
		const types = config.events?.definitions.map((d) => d.entityType)
		expect(types).toContain('github.pull_request')
		expect(types).toContain('github.issue')
		expect(types).toContain('github.push')
		expect(types).toContain('github.review')
		// deployment_status subscription is what the receiver dispatches for
		// bet/task attribution; if this drops off the list, the receiver silently
		// stops advertising the event type.
		expect(types).toContain('github.deployment_status')
	})

	it('has MCP config', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.command).toBe('npx')
		expect(config.mcp?.envKey).toBe('GITHUB_TOKEN')
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

	describe('getAccessToken', () => {
		const originalFetch = globalThis.fetch
		const originalAppId = process.env.GITHUB_APP_ID
		const originalKey = process.env.GITHUB_APP_PRIVATE_KEY

		beforeAll(() => {
			process.env.GITHUB_APP_ID = '12345'
			process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKeyPem
		})

		afterEach(() => {
			globalThis.fetch = originalFetch
			process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKeyPem
		})

		afterAll(() => {
			process.env.GITHUB_APP_ID = originalAppId
			process.env.GITHUB_APP_PRIVATE_KEY = originalKey
		})

		it('returns token on successful API call', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: 'ghs_test_token_123' }),
			})

			const token = await githubAuth.getAccessToken({ installation_id: '42' })

			expect(token).toBe('ghs_test_token_123')
			expect(globalThis.fetch).toHaveBeenCalledWith(
				'https://api.github.com/app/installations/42/access_tokens',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Accept: 'application/vnd.github+json',
					}),
				}),
			)
			// Verify the Authorization header contains a valid JWT (3 dot-separated parts)
			const call = vi.mocked(globalThis.fetch).mock.calls[0]
			const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
			const authHeader = headers.Authorization
			expect(authHeader).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
		})

		it('throws on non-OK response from GitHub API', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				text: () => Promise.resolve('Bad credentials'),
			})

			await expect(githubAuth.getAccessToken({ installation_id: '42' })).rejects.toThrow(
				'Failed to get installation access token: 401 Bad credentials',
			)
		})

		it('handles PEM key with literal \\n sequences', async () => {
			const escapedKey = testPrivateKeyPem.replace(/\n/g, '\\n')
			process.env.GITHUB_APP_PRIVATE_KEY = escapedKey

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: 'ghs_escaped' }),
			})

			const token = await githubAuth.getAccessToken({ installation_id: '99' })
			expect(token).toBe('ghs_escaped')
		})

		it('handles Base64-encoded PEM key', async () => {
			const base64Key = Buffer.from(testPrivateKeyPem).toString('base64')
			process.env.GITHUB_APP_PRIVATE_KEY = base64Key

			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: 'ghs_base64' }),
			})

			const token = await githubAuth.getAccessToken({ installation_id: '77' })
			expect(token).toBe('ghs_base64')
		})
	})

	describe('fetchInstallationOwnerLogin', () => {
		const originalFetch = globalThis.fetch
		const originalAppId = process.env.GITHUB_APP_ID
		const originalKey = process.env.GITHUB_APP_PRIVATE_KEY

		beforeAll(() => {
			process.env.GITHUB_APP_ID = '12345'
			process.env.GITHUB_APP_PRIVATE_KEY = testPrivateKeyPem
		})

		afterEach(() => {
			globalThis.fetch = originalFetch
		})

		afterAll(() => {
			process.env.GITHUB_APP_ID = originalAppId
			process.env.GITHUB_APP_PRIVATE_KEY = originalKey
		})

		it('returns account.login on successful response', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ account: { login: 'sindre-ai' } }),
			})

			const login = await fetchInstallationOwnerLogin('42')

			expect(login).toBe('sindre-ai')
			expect(globalThis.fetch).toHaveBeenCalledWith(
				'https://api.github.com/app/installations/42',
				expect.objectContaining({
					headers: expect.objectContaining({
						Accept: 'application/vnd.github+json',
					}),
				}),
			)
			const call = vi.mocked(globalThis.fetch).mock.calls[0]
			const headers = (call?.[1] as RequestInit)?.headers as Record<string, string>
			expect(headers.Authorization).toMatch(
				/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
			)
		})

		it('throws on 404 when installation no longer exists', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				text: () => Promise.resolve('Not Found'),
			})

			await expect(fetchInstallationOwnerLogin('999')).rejects.toThrow(
				'Failed to fetch installation owner: 404 Not Found',
			)
		})

		it('throws when response is missing account.login', async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ account: {} }),
			})

			await expect(fetchInstallationOwnerLogin('42')).rejects.toThrow(
				'GitHub installation response missing account.login',
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
				head: { sha: 'abc123', ref: 'feature/foo' },
				base: { ref: 'main' },
			},
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)

		expect(result).not.toBeNull()
		expect(result?.entityType).toBe('github.pull_request')
		expect(result?.action).toBe('opened')
		expect(result?.installationId).toBe('12345')
		expect(result?.data.pr_number).toBe(42)
		expect(result?.data.pr_title).toBe('Add feature')
		expect(result?.data.pr_head_sha).toBe('abc123')
		expect(result?.data.pr_head_ref).toBe('feature/foo')
		expect(result?.data.pr_base_branch).toBe('main')
	})

	it('stores merge_commit_sha on a merged pull_request so T3 can attribute the deploy', () => {
		const mergeSha = 'f'.repeat(40)
		const payload = makePayload({
			action: 'closed',
			pull_request: {
				merged: true,
				number: 7,
				title: 'PR',
				head: { sha: 'h'.repeat(40), ref: 'feature/bar' },
				base: { ref: 'main' },
				merge_commit_sha: mergeSha,
			},
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)

		expect(result?.action).toBe('merged')
		expect(result?.data.merge_commit_sha).toBe(mergeSha)
		expect(result?.data.pr_head_ref).toBe('feature/bar')
	})

	it('maps closed+merged pull_request to merged action', () => {
		const payload = makePayload({
			action: 'closed',
			pull_request: { merged: true, number: 1, title: 'PR', head: {}, base: {} },
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)
		expect(result?.action).toBe('merged')
	})

	it('maps closed (not merged) pull_request to closed action', () => {
		const payload = makePayload({
			action: 'closed',
			pull_request: { merged: false, number: 1, title: 'PR', head: {}, base: {} },
		})
		const headers = { 'x-github-event': 'pull_request' }

		const result = githubEventNormalizer(payload, headers)
		expect(result?.action).toBe('closed')
	})

	it('normalizes push event', () => {
		const sha = 'e'.repeat(40)
		const payload = makePayload({
			ref: 'refs/heads/main',
			commits: [{ id: '1' }, { id: '2' }],
			head_commit: { id: sha, message: 'Fix bug' },
		})
		const headers = { 'x-github-event': 'push' }

		const result = githubEventNormalizer(payload, headers)

		expect(result?.entityType).toBe('github.push')
		expect(result?.action).toBe('pushed')
		expect(result?.data.ref).toBe('refs/heads/main')
		expect(result?.data.commits_count).toBe(2)
		expect(result?.data.head_commit).toBe('Fix bug')
		expect(result?.data.head_commit_sha).toBe(sha)
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

		expect(result?.entityType).toBe('github.issue')
		expect(result?.action).toBe('opened')
		expect(result?.data.issue_number).toBe(10)
		expect(result?.data.issue_title).toBe('Bug report')
	})

	it('normalizes pull_request_review event', () => {
		const payload = makePayload({
			action: 'submitted',
			pull_request: { number: 5, title: 'PR', head: {}, base: {} },
			review: { state: 'approved', body: 'LGTM' },
		})
		const headers = { 'x-github-event': 'pull_request_review' }

		const result = githubEventNormalizer(payload, headers)

		expect(result?.entityType).toBe('github.review')
		expect(result?.action).toBe('submitted')
		expect(result?.data.review_state).toBe('approved')
		expect(result?.data.review_body).toBe('LGTM')
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
		;(payload as Record<string, unknown>).action = undefined
		const headers = { 'x-github-event': 'issues' }

		const result = githubEventNormalizer(payload, headers)
		expect(result?.action).toBe('unknown')
	})

	// Pre-handler filters non-success / non-production combinations before
	// normalization runs, so the shape reaching the normalizer is always a
	// production success. The normalizer stamps action='succeeded' and lifts
	// SHA, environment, and timestamps into `data` so downstream attribution
	// (T3) doesn't have to re-parse the raw payload.
	it('normalizes deployment_status event with production success', () => {
		const sha = 'a'.repeat(40)
		const createdAt = '2026-07-01T08:00:00Z'
		const updatedAt = '2026-07-01T08:00:15Z'
		const deliveryId = '4d5f7c6e-1a2b-4c3d-9e8f-0a1b2c3d4e5f'
		const payload = makePayload({
			action: 'created',
			deployment: { sha, environment: 'production', ref: 'refs/heads/main' },
			deployment_status: {
				state: 'success',
				created_at: createdAt,
				updated_at: updatedAt,
				target_url: 'https://vercel.com/logs/abc',
			},
		})
		const headers = {
			'x-github-event': 'deployment_status',
			'x-github-delivery': deliveryId,
		}

		const result = githubEventNormalizer(payload, headers)

		expect(result?.entityType).toBe('github.deployment_status')
		expect(result?.action).toBe('succeeded')
		expect(result?.data.deployment_sha).toBe(sha)
		expect(result?.data.deployment_environment).toBe('production')
		expect(result?.data.deployment_state).toBe('success')
		expect(result?.data.deployment_status_created_at).toBe(createdAt)
		expect(result?.data.deployment_status_updated_at).toBe(updatedAt)
		expect(result?.data.deployment_target_url).toBe('https://vercel.com/logs/abc')
		// The unattributed-deploy log at deployment-status.ts:150 reads
		// data.delivery_id ?? null — without this lift, every real production
		// delivery logs deliveryId: null and T4's aging sweep can't correlate
		// stuck deploys back to webhook_deliveries.
		expect(result?.data.delivery_id).toBe(deliveryId)
	})

	it('omits delivery_id on deployment_status when the header is absent', () => {
		const sha = 'a'.repeat(40)
		const payload = makePayload({
			action: 'created',
			deployment: { sha, environment: 'production', ref: 'refs/heads/main' },
			deployment_status: { state: 'success' },
		})
		const headers = { 'x-github-event': 'deployment_status' }

		const result = githubEventNormalizer(payload, headers)

		expect(result?.data.delivery_id).toBeUndefined()
	})
})

// ── Deployment_status: pre-handler + delivery-ID + fan-out + attribution ─────

describe('githubWebhookPreHandler', () => {
	const validSha = 'b'.repeat(40)
	const validDeliveryId = '1234abcd-5678-90ef-1234-567890abcdef'

	function makeDeploymentStatusPayload(overrides?: {
		deployment?: Record<string, unknown> | undefined
		deployment_status?: Record<string, unknown> | undefined
	}) {
		return {
			deployment: {
				sha: validSha,
				environment: 'production',
				ref: 'refs/heads/main',
				...(overrides?.deployment ?? {}),
			},
			deployment_status: {
				state: 'success',
				created_at: '2026-07-01T08:00:00Z',
				updated_at: '2026-07-01T08:00:15Z',
				...(overrides?.deployment_status ?? {}),
			},
		}
	}

	function headers(extra?: Record<string, string>) {
		return {
			'x-github-event': 'deployment_status',
			'x-github-delivery': validDeliveryId,
			...(extra ?? {}),
		}
	}

	it('returns null for non-deployment_status events (default path)', () => {
		const res = githubWebhookPreHandler({ any: 'payload' }, { 'x-github-event': 'push' })
		expect(res).toBeNull()
	})

	it('lets a valid production success payload proceed to normalization', () => {
		const res = githubWebhookPreHandler(makeDeploymentStatusPayload(), headers())
		expect(res).toBeNull()
	})

	it('rejects a payload with a missing SHA with 400', () => {
		const payload = makeDeploymentStatusPayload({ deployment: { sha: undefined } })
		const res = githubWebhookPreHandler(payload, headers())
		expect(res?.status).toBe(400)
		expect((res?.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
	})

	it('rejects a payload with a malformed SHA with 400', () => {
		const payload = makeDeploymentStatusPayload({ deployment: { sha: 'not-a-sha' } })
		const res = githubWebhookPreHandler(payload, headers())
		expect(res?.status).toBe(400)
	})

	it('rejects a payload whose deployment object is missing entirely with 400', () => {
		const payload = { deployment_status: { state: 'success' } }
		const res = githubWebhookPreHandler(payload, headers())
		expect(res?.status).toBe(400)
	})

	it('drops non-production environments with 200 skipped=filtered', () => {
		const payload = makeDeploymentStatusPayload({ deployment: { environment: 'staging' } })
		const res = githubWebhookPreHandler(payload, headers())
		expect(res?.status ?? 200).toBe(200)
		expect(res?.body).toEqual({ ok: true, skipped: 'filtered' })
	})

	it('drops non-success states with 200 skipped=filtered', () => {
		const payload = makeDeploymentStatusPayload({ deployment_status: { state: 'failure' } })
		const res = githubWebhookPreHandler(payload, headers())
		expect(res?.status ?? 200).toBe(200)
		expect(res?.body).toEqual({ ok: true, skipped: 'filtered' })
	})

	it('drops pending deploys even with a valid SHA', () => {
		const payload = makeDeploymentStatusPayload({ deployment_status: { state: 'pending' } })
		const res = githubWebhookPreHandler(payload, headers())
		expect(res?.body).toEqual({ ok: true, skipped: 'filtered' })
	})
})

describe('githubExtractDeliveryId', () => {
	it('returns the X-GitHub-Delivery header when present', () => {
		expect(githubExtractDeliveryId({}, { 'x-github-delivery': 'abc-123' })).toBe('abc-123')
	})

	it('returns null when the delivery header is missing', () => {
		expect(githubExtractDeliveryId({}, {})).toBeNull()
	})

	it('returns null for empty string delivery id', () => {
		expect(githubExtractDeliveryId({}, { 'x-github-delivery': '' })).toBeNull()
	})
})

describe('attributeDeployment', () => {
	it('passes the deploy args through to the attribution service and returns matched=true on a hit', async () => {
		const spy = vi.spyOn(deployAttribution, 'attributeDeploymentToObject').mockResolvedValueOnce({
			matched: true,
			objectId: 'bet-1',
			objectType: 'bet',
			reason: 'pass1_push',
		})
		try {
			const res = await attributeDeployment({
				db: {},
				workspaceId: 'ws-1',
				sha: 'c'.repeat(40),
				deployedAt: '2026-07-01T08:00:00Z',
				installationId: 'inst-1',
				deploymentRef: 'refs/heads/main',
				deliveryId: 'del-1',
			})
			expect(res).toEqual({ matched: true })
			expect(spy).toHaveBeenCalledWith(
				expect.objectContaining({
					workspaceId: 'ws-1',
					sha: 'c'.repeat(40),
					deployedAt: '2026-07-01T08:00:00Z',
					deploymentRef: 'refs/heads/main',
					deliveryId: 'del-1',
				}),
			)
		} finally {
			spy.mockRestore()
		}
	})

	it('returns matched=false when the service finds no match', async () => {
		const spy = vi
			.spyOn(deployAttribution, 'attributeDeploymentToObject')
			.mockResolvedValueOnce({ matched: false })
		try {
			const res = await attributeDeployment({
				db: {},
				workspaceId: 'ws-1',
				sha: 'c'.repeat(40),
				deployedAt: '2026-07-01T08:00:00Z',
				installationId: 'inst-1',
			})
			expect(res).toEqual({ matched: false })
		} finally {
			spy.mockRestore()
		}
	})
})

describe('githubWebhookFanOut', () => {
	function normalizedDeploymentStatus(
		data: Partial<Record<string, unknown>> = {},
	): import('../../../../lib/integrations/types').NormalizedEvent {
		return {
			entityType: 'github.deployment_status',
			action: 'succeeded',
			installationId: 'inst-42',
			data: {
				deployment_sha: 'd'.repeat(40),
				deployment_environment: 'production',
				deployment_state: 'success',
				deployment_status_updated_at: '2026-07-01T08:00:15Z',
				...data,
			},
		}
	}

	function fanOutCtx(normalized: import('../../../../lib/integrations/types').NormalizedEvent) {
		return {
			db: {},
			storage: {},
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			normalized,
		}
	}

	it('returns [] for deployment_status so no event row lands', async () => {
		const spy = vi
			.spyOn(deployAttribution, 'attributeDeploymentToObject')
			.mockResolvedValue({ matched: false })
		try {
			const events = await githubWebhookFanOut(fanOutCtx(normalizedDeploymentStatus()))
			expect(events).toEqual([])
		} finally {
			spy.mockRestore()
		}
	})

	it('logs an unattributed record when attribution finds no match', async () => {
		const deliveryId = '9f8e7d6c-5b4a-4938-9271-6f5e4d3c2b1a'
		const spy = vi
			.spyOn(deployAttribution, 'attributeDeploymentToObject')
			.mockResolvedValue({ matched: false })
		const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
		try {
			await githubWebhookFanOut(fanOutCtx(normalizedDeploymentStatus({ delivery_id: deliveryId })))
			const logged = infoSpy.mock.calls.map(([m]) => String(m)).join('\n')
			expect(logged).toContain('deployment_status unattributed')
			expect(logged).toContain('d'.repeat(40))
			// Delivery id must appear in the log so T4's aging sweep can grep it
			// back to `webhook_deliveries`. Without the normalizer lifting
			// `x-github-delivery` into `data.delivery_id`, this line wrote
			// `deliveryId: null` and correlation was impossible.
			expect(logged).toContain(deliveryId)
		} finally {
			infoSpy.mockRestore()
			spy.mockRestore()
		}
	})

	it('does not log unattributed when attribution matches', async () => {
		const spy = vi
			.spyOn(deployAttribution, 'attributeDeploymentToObject')
			.mockResolvedValue({ matched: true, objectId: 'bet-1', objectType: 'bet' })
		const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
		try {
			await githubWebhookFanOut(fanOutCtx(normalizedDeploymentStatus()))
			const logged = infoSpy.mock.calls.map(([m]) => String(m)).join('\n')
			expect(logged).not.toContain('deployment_status unattributed')
		} finally {
			infoSpy.mockRestore()
			spy.mockRestore()
		}
	})

	it('passes other GitHub events through unchanged', async () => {
		const push: import('../../../../lib/integrations/types').NormalizedEvent = {
			entityType: 'github.push',
			action: 'pushed',
			installationId: 'inst-42',
			data: { ref: 'refs/heads/main' },
		}
		const events = await githubWebhookFanOut(fanOutCtx(push))
		expect(events).toEqual([push])
	})

	it('does not throw when timestamps are missing (falls back to now)', async () => {
		const spy = vi
			.spyOn(deployAttribution, 'attributeDeploymentToObject')
			.mockResolvedValue({ matched: false })
		try {
			const events = await githubWebhookFanOut(
				fanOutCtx(
					normalizedDeploymentStatus({
						deployment_status_updated_at: undefined,
						deployment_status_created_at: undefined,
					}),
				),
			)
			expect(events).toEqual([])
		} finally {
			spy.mockRestore()
		}
	})
})
