import { describe, expect, it } from 'vitest'
import {
	buildAuthorizationServerDocument,
	buildMcpChallenge,
	buildProtectedResourceDocument,
	resolveOAuthIssuer,
} from '../../lib/oauth-server/discovery'

describe('issuer', () => {
	it('is the production origin when nothing is configured', () => {
		expect(resolveOAuthIssuer({})).toBe('https://maskin.io')
	})

	it('follows the web app origin, without a trailing slash', () => {
		expect(resolveOAuthIssuer({ WEB_APP_URL: 'https://app.example.com/' })).toBe(
			'https://app.example.com',
		)
		expect(resolveOAuthIssuer({ FRONTEND_URL: 'http://localhost:5173' })).toBe(
			'http://localhost:5173',
		)
	})

	it('prefers MASKIN_OAUTH_ISSUER over the web app origin and strips its trailing slash', () => {
		expect(
			resolveOAuthIssuer({
				MASKIN_OAUTH_ISSUER: 'http://localhost:3000/',
				WEB_APP_URL: 'https://app.example.com',
			}),
		).toBe('http://localhost:3000')
	})

	it('treats an empty MASKIN_OAUTH_ISSUER as unset', () => {
		expect(
			resolveOAuthIssuer({ MASKIN_OAUTH_ISSUER: '  ', WEB_APP_URL: 'https://a.example' }),
		).toBe('https://a.example')
	})
})

describe('protected resource document', () => {
	it('matches the contract for the default origin', () => {
		expect(buildProtectedResourceDocument({})).toEqual({
			resource: 'https://maskin.io/mcp',
			authorization_servers: ['https://maskin.io'],
			scopes_supported: ['mcp'],
			bearer_methods_supported: ['header'],
			resource_name: 'Maskin',
		})
	})

	it('has resource and authorization server follow the configured origin', () => {
		const a = buildProtectedResourceDocument({ MASKIN_OAUTH_ISSUER: 'https://one.example' })
		const b = buildProtectedResourceDocument({ MASKIN_OAUTH_ISSUER: 'http://localhost:3000' })

		expect(a.resource).toBe('https://one.example/mcp')
		expect(a.authorization_servers).toEqual(['https://one.example'])
		expect(b.resource).toBe('http://localhost:3000/mcp')
		expect(b.authorization_servers).toEqual(['http://localhost:3000'])
	})
})

describe('authorization server document', () => {
	it('matches the contract for the default origin', () => {
		expect(buildAuthorizationServerDocument({})).toEqual({
			issuer: 'https://maskin.io',
			authorization_endpoint: 'https://maskin.io/oauth/authorize',
			token_endpoint: 'https://maskin.io/oauth/token',
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			scopes_supported: ['mcp'],
			client_id_metadata_document_supported: true,
			authorization_response_iss_parameter_supported: true,
		})
	})

	it('has the issuer and both endpoints follow the configured origin (two env values)', () => {
		const a = buildAuthorizationServerDocument({ WEB_APP_URL: 'https://one.example' })
		const b = buildAuthorizationServerDocument({ MASKIN_OAUTH_ISSUER: 'http://localhost:3000' })

		expect(a.issuer).toBe('https://one.example')
		expect(a.authorization_endpoint).toBe('https://one.example/oauth/authorize')
		expect(a.token_endpoint).toBe('https://one.example/oauth/token')
		expect(b.issuer).toBe('http://localhost:3000')
		expect(b.token_endpoint).toBe('http://localhost:3000/oauth/token')
	})

	it('has no registration endpoint, and keeps the two values Claude needs to skip dynamic registration', () => {
		const doc = buildAuthorizationServerDocument({})

		expect(doc).not.toHaveProperty('registration_endpoint')
		expect(doc.client_id_metadata_document_supported).toBe(true)
		expect(doc.token_endpoint_auth_methods_supported).toContain('none')
	})
})

describe('WWW-Authenticate challenge', () => {
	it('points at the protected resource document and names the scope', () => {
		expect(buildMcpChallenge({}, {})).toBe(
			'Bearer resource_metadata="https://maskin.io/.well-known/oauth-protected-resource/mcp", scope="mcp"',
		)
	})

	it('adds error="invalid_token" before resource_metadata for a bad token', () => {
		const header = buildMcpChallenge({ invalidToken: true }, {})

		expect(header.startsWith('Bearer error="invalid_token", error_description="')).toBe(true)
		expect(header.indexOf('error="invalid_token"')).toBeLessThan(
			header.indexOf('resource_metadata='),
		)
		expect(header.endsWith('scope="mcp"')).toBe(true)
	})

	it('follows the configured origin', () => {
		expect(buildMcpChallenge({}, { MASKIN_OAUTH_ISSUER: 'http://localhost:3000' })).toContain(
			'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
		)
	})
})
