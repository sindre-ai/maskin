import { generateKeyPairSync } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mintAgentAppInstallationToken } from '../../../../lib/integrations/providers/github/agent-app'

const { privateKey: testPrivateKeyPem } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('mintAgentAppInstallationToken', () => {
	const originalFetch = globalThis.fetch
	const originalId = process.env.GITHUB_APP_ID_SINDRE_AI
	const originalKey = process.env.GITHUB_APP_PRIVATE_KEY_SINDRE_AI

	beforeAll(() => {
		process.env.GITHUB_APP_ID_SINDRE_AI = '54321'
		process.env.GITHUB_APP_PRIVATE_KEY_SINDRE_AI = testPrivateKeyPem
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
	})

	afterAll(() => {
		process.env.GITHUB_APP_ID_SINDRE_AI = originalId
		process.env.GITHUB_APP_PRIVATE_KEY_SINDRE_AI = originalKey
	})

	it('mints a token against the sindre-ai-agents App and returns token + expiresAt', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({ token: 'ghs_agent_token_abc', expires_at: '2026-07-12T20:00:00Z' }),
		})

		const result = await mintAgentAppInstallationToken({ installationId: 'inst-777' })

		expect(result.token).toBe('ghs_agent_token_abc')
		expect(result.expiresAt).toBe('2026-07-12T20:00:00Z')
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://api.github.com/app/installations/inst-777/access_tokens',
			expect.objectContaining({ method: 'POST' }),
		)
		const call = vi.mocked(globalThis.fetch).mock.calls[0]
		const init = call?.[1] as RequestInit
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
		expect(init.body).toBeUndefined()
	})

	it('narrows the token to specific repositories when requested', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ token: 'ghs_narrow', expires_at: '2026-07-12T20:00:00Z' }),
		})

		await mintAgentAppInstallationToken({
			installationId: 'inst-1',
			repositories: ['maskin'],
		})

		const call = vi.mocked(globalThis.fetch).mock.calls[0]
		const init = call?.[1] as RequestInit
		expect(JSON.parse(String(init.body))).toEqual({ repositories: ['maskin'] })
	})

	it('narrows the token to specific permissions when requested', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ token: 'ghs_perm', expires_at: '2026-07-12T20:00:00Z' }),
		})

		await mintAgentAppInstallationToken({
			installationId: 'inst-1',
			permissions: { pull_requests: 'write', contents: 'read' },
		})

		const call = vi.mocked(globalThis.fetch).mock.calls[0]
		const init = call?.[1] as RequestInit
		expect(JSON.parse(String(init.body))).toEqual({
			permissions: { pull_requests: 'write', contents: 'read' },
		})
	})

	it('percent-encodes the installation id path segment', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({ token: 'ghs_x', expires_at: '2026-07-12T20:00:00Z' }),
		})

		await mintAgentAppInstallationToken({ installationId: 'weird id/with slash' })

		const call = vi.mocked(globalThis.fetch).mock.calls[0]
		expect(String(call?.[0])).toContain('/app/installations/weird%20id%2Fwith%20slash/')
	})

	it('surfaces a descriptive error when GitHub rejects the mint request', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			text: () => Promise.resolve('Resource not accessible by integration'),
		})

		await expect(mintAgentAppInstallationToken({ installationId: 'inst-1' })).rejects.toThrow(
			'Failed to mint sindre-ai-agents installation token: 403 Resource not accessible by integration',
		)
	})

	it('throws when the response body is missing token or expires_at', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({}),
		})

		await expect(mintAgentAppInstallationToken({ installationId: 'inst-1' })).rejects.toThrow(
			'sindre-ai-agents installation token response missing token or expires_at',
		)
	})

	it('throws a clear error when the sindre-ai-agents credentials are absent', async () => {
		process.env.GITHUB_APP_ID_SINDRE_AI = ''

		await expect(mintAgentAppInstallationToken({ installationId: 'inst-1' })).rejects.toThrow(
			'GITHUB_APP_ID_SINDRE_AI environment variable is required',
		)
	})
})
