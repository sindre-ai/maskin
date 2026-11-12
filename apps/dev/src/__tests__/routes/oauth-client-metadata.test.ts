import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import oauthClientMetadataRoutes from '../../routes/oauth-client-metadata'

const PATH = '/oauth/client-metadata/vercel.json'

describe('Vercel client metadata document', () => {
	beforeEach(() => {
		vi.stubEnv('CORS_ORIGIN', 'https://app.example.com')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('serves a public client whose client_id is its own address', async () => {
		const res = await oauthClientMetadataRoutes.request(PATH)
		expect(res.status).toBe(200)
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		const doc = await res.json()
		expect(doc).toEqual({
			client_id: `https://app.example.com${PATH}`,
			client_name: 'Maskin',
			client_uri: 'https://app.example.com',
			redirect_uris: ['https://app.example.com/api/integrations/vercel/callback'],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		})
	})

	it('uses the request origin when no public origin is configured', async () => {
		vi.stubEnv('CORS_ORIGIN', '')
		const doc = await (
			await oauthClientMetadataRoutes.request(`https://test.example.com${PATH}`)
		).json()
		expect(doc.client_id).toBe(`https://test.example.com${PATH}`)
		expect(doc.redirect_uris).toEqual(['https://test.example.com/api/integrations/vercel/callback'])
	})
})
