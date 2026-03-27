import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuth2Handler } from '../../../lib/integrations/oauth/handler'
import type { OAuth2Config } from '../../../lib/integrations/types'

// Mock getEnvOrThrow
vi.mock('../../../lib/integrations/env', () => ({
	getEnvOrThrow: vi.fn((name: string) => {
		const env: Record<string, string> = {
			TEST_CLIENT_ID: 'my-client-id',
			TEST_CLIENT_SECRET: 'my-client-secret',
		}
		return env[name] || `mock-${name}`
	}),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const baseConfig: OAuth2Config = {
	authorizationUrl: 'https://provider.com/authorize',
	tokenUrl: 'https://provider.com/token',
	scopes: ['read', 'write'],
	clientIdEnv: 'TEST_CLIENT_ID',
	clientSecretEnv: 'TEST_CLIENT_SECRET',
}

describe('OAuth2Handler', () => {
	afterEach(() => {
		vi.restoreAllMocks()
		mockFetch.mockReset()
	})

	describe('createAuthorizationUrl', () => {
		it('builds URL with required params', () => {
			const handler = new OAuth2Handler(baseConfig)
			const url = new URL(handler.createAuthorizationUrl('state-123', 'https://app.com/callback'))

			expect(url.origin + url.pathname).toBe('https://provider.com/authorize')
			expect(url.searchParams.get('response_type')).toBe('code')
			expect(url.searchParams.get('client_id')).toBe('my-client-id')
			expect(url.searchParams.get('redirect_uri')).toBe('https://app.com/callback')
			expect(url.searchParams.get('state')).toBe('state-123')
			expect(url.searchParams.get('scope')).toBe('read write')
		})

		it('omits scope when scopes array is empty', () => {
			const handler = new OAuth2Handler({ ...baseConfig, scopes: [] })
			const url = new URL(handler.createAuthorizationUrl('state', 'https://app.com/callback'))

			expect(url.searchParams.has('scope')).toBe(false)
		})

		it('includes PKCE code challenge when enabled', () => {
			const handler = new OAuth2Handler({ ...baseConfig, pkce: true })
			const url = new URL(
				handler.createAuthorizationUrl('state', 'https://app.com/callback', 'test-verifier'),
			)

			expect(url.searchParams.has('code_challenge')).toBe(true)
			expect(url.searchParams.get('code_challenge_method')).toBe('S256')
		})

		it('does not include PKCE when pkce is false', () => {
			const handler = new OAuth2Handler(baseConfig)
			const url = new URL(
				handler.createAuthorizationUrl('state', 'https://app.com/callback', 'verifier'),
			)

			expect(url.searchParams.has('code_challenge')).toBe(false)
		})

		it('includes extra auth params', () => {
			const handler = new OAuth2Handler({
				...baseConfig,
				extraAuthParams: { access_type: 'offline', prompt: 'consent' },
			})
			const url = new URL(handler.createAuthorizationUrl('state', 'https://app.com/callback'))

			expect(url.searchParams.get('access_type')).toBe('offline')
			expect(url.searchParams.get('prompt')).toBe('consent')
		})
	})

	describe('exchangeCode', () => {
		it('sends correct request and parses token response', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: 'access-123',
					refresh_token: 'refresh-456',
					expires_in: 3600,
					token_type: 'Bearer',
					scope: 'read write',
				}),
			})

			const handler = new OAuth2Handler(baseConfig)
			const now = Date.now()
			const result = await handler.exchangeCode('auth-code', 'https://app.com/callback')

			expect(mockFetch).toHaveBeenCalledOnce()
			const [url, options] = mockFetch.mock.calls[0]
			expect(url).toBe('https://provider.com/token')
			expect(options.method).toBe('POST')

			const body = new URLSearchParams(options.body)
			expect(body.get('grant_type')).toBe('authorization_code')
			expect(body.get('code')).toBe('auth-code')
			expect(body.get('redirect_uri')).toBe('https://app.com/callback')
			expect(body.get('client_id')).toBe('my-client-id')
			expect(body.get('client_secret')).toBe('my-client-secret')

			expect(result.accessToken).toBe('access-123')
			expect(result.refreshToken).toBe('refresh-456')
			expect(result.tokenType).toBe('Bearer')
			expect(result.scope).toBe('read write')
			expect(result.expiresAt).toBeGreaterThanOrEqual(now + 3600 * 1000 - 100)
		})

		it('includes code_verifier for PKCE', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({ access_token: 'token' }),
			})

			const handler = new OAuth2Handler({ ...baseConfig, pkce: true })
			await handler.exchangeCode('code', 'https://app.com/callback', 'my-verifier')

			const body = new URLSearchParams(mockFetch.mock.calls[0][1].body)
			expect(body.get('code_verifier')).toBe('my-verifier')
		})

		it('throws on non-ok response', async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => 'Bad Request',
			})

			const handler = new OAuth2Handler(baseConfig)
			await expect(handler.exchangeCode('bad-code', 'https://app.com/callback')).rejects.toThrow(
				'Token exchange failed: 400 Bad Request',
			)
		})

		it('handles expires_at in seconds (converts to ms)', async () => {
			const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: 'token',
					expires_at: expiresAtSeconds,
				}),
			})

			const handler = new OAuth2Handler(baseConfig)
			const result = await handler.exchangeCode('code', 'https://app.com/callback')

			expect(result.expiresAt).toBe(expiresAtSeconds * 1000)
		})

		it('handles expires_at in milliseconds (keeps as-is)', async () => {
			const expiresAtMs = Date.now() + 3600 * 1000
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: 'token',
					expires_at: expiresAtMs,
				}),
			})

			const handler = new OAuth2Handler(baseConfig)
			const result = await handler.exchangeCode('code', 'https://app.com/callback')

			expect(result.expiresAt).toBe(expiresAtMs)
		})
	})

	describe('client_secret_basic', () => {
		it('sends Basic auth header instead of body params', async () => {
			const config: OAuth2Config = {
				...baseConfig,
				tokenAuthMethod: 'client_secret_basic',
			}
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({ access_token: 'token' }),
			})

			const handler = new OAuth2Handler(config)
			await handler.exchangeCode('code', 'https://app.com/callback')

			const [, options] = mockFetch.mock.calls[0]
			const headers = options.headers as Headers
			const authHeader = headers.get('Authorization')
			const expected = Buffer.from('my-client-id:my-client-secret').toString('base64')
			expect(authHeader).toBe(`Basic ${expected}`)

			const body = new URLSearchParams(options.body)
			expect(body.has('client_id')).toBe(false)
			expect(body.has('client_secret')).toBe(false)
		})
	})

	describe('custom parser', () => {
		it('merges custom parser results with standard parsing', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: 'token',
					custom_field: 'custom-value',
				}),
			})

			const customParser = (raw: unknown) => {
				const data = raw as Record<string, unknown>
				return { customField: data.custom_field as string }
			}

			const handler = new OAuth2Handler(baseConfig, customParser)
			const result = await handler.exchangeCode('code', 'https://app.com/callback')

			expect(result.accessToken).toBe('token')
			expect((result as Record<string, unknown>).customField).toBe('custom-value')
		})
	})

	describe('refreshToken', () => {
		it('sends refresh_token grant type', async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => ({
					access_token: 'new-token',
					refresh_token: 'new-refresh',
					expires_in: 7200,
				}),
			})

			const handler = new OAuth2Handler(baseConfig)
			const result = await handler.refreshToken('old-refresh-token')

			const body = new URLSearchParams(mockFetch.mock.calls[0][1].body)
			expect(body.get('grant_type')).toBe('refresh_token')
			expect(body.get('refresh_token')).toBe('old-refresh-token')

			expect(result.accessToken).toBe('new-token')
			expect(result.refreshToken).toBe('new-refresh')
		})
	})

	describe('revokeToken', () => {
		it('calls revoke URL when configured', async () => {
			mockFetch.mockResolvedValue({ ok: true })
			const config: OAuth2Config = {
				...baseConfig,
				revokeUrl: 'https://provider.com/revoke',
			}
			const handler = new OAuth2Handler(config)
			await handler.revokeToken('token-to-revoke')

			expect(mockFetch).toHaveBeenCalledOnce()
			const [url, options] = mockFetch.mock.calls[0]
			expect(url).toBe('https://provider.com/revoke')
			const body = new URLSearchParams(options.body)
			expect(body.get('token')).toBe('token-to-revoke')
		})

		it('does nothing when no revokeUrl configured', async () => {
			const handler = new OAuth2Handler(baseConfig)
			await handler.revokeToken('token')

			expect(mockFetch).not.toHaveBeenCalled()
		})
	})
})
