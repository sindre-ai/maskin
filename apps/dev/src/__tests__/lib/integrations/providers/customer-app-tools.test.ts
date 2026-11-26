import { describe, expect, it } from 'vitest'
import { FLAGS } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { config as box } from '../../../../lib/integrations/providers/box/config'
import { config as lattice } from '../../../../lib/integrations/providers/lattice/config'
import { getProvider } from '../../../../lib/integrations/registry'

describe('Box provider config', () => {
	it('signs in on Box with the code flow, PKCE and the two scopes every plan has', () => {
		expect(box.name).toBe('box')
		expect(box.displayName).toBe('Box')
		expect(box.auth.type).toBe('oauth2')
		if (box.auth.type === 'oauth2') {
			expect(box.auth.config.authorizationUrl).toBe('https://account.box.com/api/oauth2/authorize')
			expect(box.auth.config.tokenUrl).toBe('https://api.box.com/oauth2/token')
			expect(box.auth.config.revokeUrl).toBe('https://api.box.com/oauth2/revoke')
			// docgen.readwrite needs Enterprise Advanced, so it is left out.
			expect(box.auth.config.scopes).toEqual(['root_readwrite', 'ai.readwrite'])
			expect(box.auth.config.pkce).toBe(true)
			expect(box.auth.config.tokenAuthMethod).toBe('client_secret_post')
			expect(box.auth.config.customerApp).toBe(true)
		}
	})

	it('declares the hosted server with a bearer token', () => {
		expect(box.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.box.com',
			headers: { Authorization: 'Bearer ${BOX_TOKEN}' },
		})
		expect(box.mcp?.envKey).toBe('BOX_TOKEN')
	})
})

describe('Lattice provider config', () => {
	it('signs in on the Lattice authorization server with the code flow and PKCE', () => {
		expect(lattice.name).toBe('lattice')
		expect(lattice.displayName).toBe('Lattice')
		expect(lattice.auth.type).toBe('oauth2')
		if (lattice.auth.type === 'oauth2') {
			expect(lattice.auth.config.authorizationUrl).toBe(
				'https://api-auth.latticehq.com/oauth2/auth',
			)
			expect(lattice.auth.config.tokenUrl).toBe('https://api-auth.latticehq.com/oauth2/token')
			expect(lattice.auth.config.revokeUrl).toBe('https://api-auth.latticehq.com/oauth2/revoke')
			expect(lattice.auth.config.pkce).toBe(true)
			expect(lattice.auth.config.tokenAuthMethod).toBe('client_secret_post')
			expect(lattice.auth.config.customerApp).toBe(true)
		}
	})

	it('asks for refresh tokens and only scopes the server lists', () => {
		if (lattice.auth.type !== 'oauth2') throw new Error('not oauth2')
		const scopes = lattice.auth.config.scopes ?? []
		expect(scopes).toContain('offline_access')
		const server = scopes.filter((s) => s !== 'offline_access')
		expect(server).toHaveLength(13)
		for (const s of server) expect(s).toMatch(/^mcp:[a-z]+\.(read|write)$/)
	})

	it('declares the hosted server with a bearer token', () => {
		expect(lattice.mcp?.server).toEqual({
			type: 'http',
			url: 'https://api.latticehq.com/mcp',
			headers: { Authorization: 'Bearer ${LATTICE_TOKEN}' },
		})
		expect(lattice.mcp?.envKey).toBe('LATTICE_TOKEN')
	})
})

describe('Box and Lattice wiring', () => {
	it('are registered and counted by the gateway', () => {
		expect(getProvider('box').config).toBe(box)
		expect(getProvider('lattice').config).toBe(lattice)
		expect(GATEWAY_PROVIDERS.has('box')).toBe(true)
		expect(GATEWAY_PROVIDERS.has('lattice')).toBe(true)
	})

	it('sit behind their own flag', () => {
		expect(FLAGS.CUSTOMER_APP_TOOLS).toBe('customer-app-tools')
	})
})
