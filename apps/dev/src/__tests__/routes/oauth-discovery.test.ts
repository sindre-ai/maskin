import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import oauthDiscoveryRoutes from '../../routes/oauth-discovery'

const PATHS = [
	'/.well-known/oauth-protected-resource',
	'/.well-known/oauth-protected-resource/mcp',
	'/.well-known/oauth-authorization-server',
]

describe('Claude sign-in discovery routes', () => {
	beforeEach(() => {
		vi.stubEnv('MASKIN_OAUTH_ISSUER', '')
		vi.stubEnv('WEB_APP_URL', '')
		vi.stubEnv('FRONTEND_URL', '')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	describe('switch on', () => {
		beforeEach(() => {
			vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		})

		it('serves the protected resource document at both paths', async () => {
			for (const path of PATHS.slice(0, 2)) {
				const res = await oauthDiscoveryRoutes.request(path)

				expect(res.status).toBe(200)
				expect(await res.json()).toEqual({
					resource: 'https://maskin.io/mcp',
					authorization_servers: ['https://maskin.io'],
					scopes_supported: ['mcp'],
					bearer_methods_supported: ['header'],
					resource_name: 'Maskin',
				})
			}
		})

		it('serves the authorization server document', async () => {
			const res = await oauthDiscoveryRoutes.request(PATHS[2])
			const doc = await res.json()

			expect(res.status).toBe(200)
			expect(doc).toMatchObject({
				issuer: 'https://maskin.io',
				authorization_endpoint: 'https://maskin.io/oauth/authorize',
				token_endpoint: 'https://maskin.io/oauth/token',
				client_id_metadata_document_supported: true,
				token_endpoint_auth_methods_supported: ['none'],
			})
			expect(doc).not.toHaveProperty('registration_endpoint')
		})

		it('follows the configured origin on every route', async () => {
			vi.stubEnv('MASKIN_OAUTH_ISSUER', 'http://localhost:3000')

			const resource = await (await oauthDiscoveryRoutes.request(PATHS[1])).json()
			const server = await (await oauthDiscoveryRoutes.request(PATHS[2])).json()

			expect(resource.resource).toBe('http://localhost:3000/mcp')
			expect(server.issuer).toBe('http://localhost:3000')
		})

		it('is public, cacheable for an hour and open to any origin without credentials', async () => {
			for (const path of PATHS) {
				const res = await oauthDiscoveryRoutes.request(path, {
					headers: { Origin: 'https://claude.ai' },
				})

				expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
				expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
				expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull()
			}
		})
	})

	describe('switch off', () => {
		it.each(PATHS)('answers 404 on %s', async (path) => {
			vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')

			const res = await oauthDiscoveryRoutes.request(path)

			expect(res.status).toBe(404)
			expect(res.headers.get('Cache-Control')).toBeNull()
		})
	})
})
