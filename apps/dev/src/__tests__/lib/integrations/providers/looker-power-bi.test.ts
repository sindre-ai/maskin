import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookupMock = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup: lookupMock }))

import { FLAGS } from '../../../../lib/feature-flags'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { OAuth2Handler } from '../../../../lib/integrations/oauth/handler'
import { config as looker } from '../../../../lib/integrations/providers/looker/config'
import { config as powerBi } from '../../../../lib/integrations/providers/power-bi/config'
import { getProvider } from '../../../../lib/integrations/registry'
import type { OAuth2Config } from '../../../../lib/integrations/types'

function oauth(config: typeof looker): OAuth2Config {
	if (config.auth.type !== 'oauth2') throw new Error('not oauth2')
	return config.auth.config
}

describe('Looker provider config', () => {
	it('is a public client with PKCE on the customer instance, and asks for the instance address', () => {
		const auth = oauth(looker)
		expect(auth.authorizationUrl).toBe('https://{value}/auth')
		expect(auth.tokenUrl).toBe('https://{value}/api/token')
		expect(auth.scopes).toEqual(['cors_api'])
		expect(auth.pkce).toBe(true)
		expect(auth.tokenAuthMethod).toBe('none')
		expect(auth.customerApp).toBe(true)
		expect(auth.customerValue?.kind).toBe('host')
		// Only the vendor's own domains: a typed host can never point the server anywhere else.
		expect(auth.customerValue?.hostSuffixes).toEqual(['looker.com', 'looker.app'])
	})

	it('serves the managed MCP server at the instance, with a bearer token', () => {
		expect(looker.mcp?.server).toEqual({
			type: 'http',
			url: 'https://{value}/mcp',
			headers: { Authorization: 'Bearer ${LOOKER_TOKEN}' },
		})
		expect(looker.mcp?.envKey).toBe('LOOKER_TOKEN')
	})
})

describe('Power BI provider config', () => {
	it('signs in on the customer tenant with the Power BI scope', () => {
		const auth = oauth(powerBi)
		expect(auth.authorizationUrl).toBe(
			'https://login.microsoftonline.com/{value}/oauth2/v2.0/authorize',
		)
		expect(auth.tokenUrl).toBe('https://login.microsoftonline.com/{value}/oauth2/v2.0/token')
		expect(auth.scopes).toEqual([
			'offline_access',
			'https://analysis.windows.net/powerbi/api/.default',
		])
		expect(auth.customerApp).toBe(true)
		expect(auth.customerValue?.kind).toBe('tenant')
		expect(auth.tokenAuthMethod).toBe('client_secret_post')
	})

	it('declares the remote server, which is the same for every customer', () => {
		expect(powerBi.mcp?.server).toEqual({
			type: 'http',
			url: 'https://api.fabric.microsoft.com/v1/mcp/powerbi',
			headers: { Authorization: 'Bearer ${POWER_BI_TOKEN}' },
		})
	})
})

describe('Looker and Power BI wiring', () => {
	it('are registered, behind the customer-app-tools flag, and counted by the gateway', () => {
		expect(getProvider('looker').config).toBe(looker)
		expect(getProvider('power-bi').config).toBe(powerBi)
		expect(GATEWAY_PROVIDERS.has('looker')).toBe(true)
		expect(GATEWAY_PROVIDERS.has('power-bi')).toBe(true)
		expect(FLAGS.CUSTOMER_APP_TOOLS).toBe('customer-app-tools')
	})
})

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

describe('Sign-in on the customer address', () => {
	beforeEach(() => {
		lookupMock.mockReset()
		lookupMock.mockResolvedValue(PUBLIC)
	})

	it('Looker: the authorize URL is on the saved instance, with no secret and a PKCE challenge', () => {
		const handler = new OAuth2Handler(oauth(looker), undefined, {
			clientId: 'client-guid',
			clientSecret: '',
			value: 'acme.cloud.looker.com',
		})
		const url = new URL(handler.createAuthorizationUrl('state', 'https://app/cb', 'verifier'))
		expect(url.origin + url.pathname).toBe('https://acme.cloud.looker.com/auth')
		expect(url.searchParams.get('client_id')).toBe('client-guid')
		expect(url.searchParams.get('scope')).toBe('cors_api')
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
	})

	it('Looker: the token request goes to the saved instance and sends only the client id', async () => {
		const calls: { url: string; body: string }[] = []
		const original = globalThis.fetch
		globalThis.fetch = (async (url: string, init: { body: string }) => {
			calls.push({ url, body: init.body })
			return new Response(
				JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }),
			)
		}) as unknown as typeof fetch
		try {
			const handler = new OAuth2Handler(oauth(looker), undefined, {
				clientId: 'client-guid',
				clientSecret: '',
				value: 'acme.cloud.looker.com',
			})
			await handler.exchangeCode('code', 'https://app/cb', 'verifier')
			await handler.refreshToken('rt')
		} finally {
			globalThis.fetch = original
		}
		expect(calls.map((c) => c.url)).toEqual([
			'https://acme.cloud.looker.com/api/token',
			'https://acme.cloud.looker.com/api/token',
		])
		for (const call of calls) {
			expect(call.body).toContain('client_id=client-guid')
			expect(call.body).not.toContain('client_secret')
		}
	})

	it('Power BI: the authorize URL is on the saved tenant', () => {
		const handler = new OAuth2Handler(oauth(powerBi), undefined, {
			clientId: 'app-id',
			clientSecret: 's3cr3t',
			value: '11111111-2222-3333-4444-555555555555',
		})
		const url = new URL(handler.createAuthorizationUrl('state', 'https://app/cb', 'verifier'))
		expect(url.origin + url.pathname).toBe(
			'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize',
		)
	})

	it('refuses to sign in at a saved value that no longer passes the check', () => {
		const handler = new OAuth2Handler(oauth(looker), undefined, {
			clientId: 'client-guid',
			clientSecret: '',
			value: '169.254.169.254',
		})
		expect(() => handler.createAuthorizationUrl('state', 'https://app/cb')).toThrow()
	})

	it('refuses to sign in with no saved value', () => {
		const handler = new OAuth2Handler(oauth(looker), undefined, {
			clientId: 'client-guid',
			clientSecret: '',
		})
		expect(() => handler.createAuthorizationUrl('state', 'https://app/cb')).toThrow()
	})

	it('refuses a token request when the host now resolves inside our network', async () => {
		lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
		const fetchSpy = vi.fn()
		const original = globalThis.fetch
		globalThis.fetch = fetchSpy as unknown as typeof fetch
		try {
			const handler = new OAuth2Handler(oauth(looker), undefined, {
				clientId: 'client-guid',
				clientSecret: '',
				value: 'acme.cloud.looker.com',
			})
			await expect(handler.exchangeCode('code', 'https://app/cb', 'verifier')).rejects.toThrow(
				'not reachable',
			)
			await expect(handler.refreshToken('rt')).rejects.toThrow('not reachable')
		} finally {
			globalThis.fetch = original
		}
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('refuses when one of several addresses is private, and when the host does not resolve', async () => {
		const handler = new OAuth2Handler(oauth(looker), undefined, {
			clientId: 'client-guid',
			clientSecret: '',
			value: 'acme.cloud.looker.com',
		})
		lookupMock.mockResolvedValue([...PUBLIC, { address: '127.0.0.1', family: 4 }])
		await expect(handler.refreshToken('rt')).rejects.toThrow('not reachable')
		lookupMock.mockRejectedValue(new Error('ENOTFOUND'))
		await expect(handler.refreshToken('rt')).rejects.toThrow("Couldn't find")
	})

	it('does not follow a redirect from the customer host to another host', async () => {
		const seen: RequestInit[] = []
		const original = globalThis.fetch
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			seen.push(init)
			return new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } })
		}) as unknown as typeof fetch
		try {
			const handler = new OAuth2Handler(oauth(looker), undefined, {
				clientId: 'client-guid',
				clientSecret: '',
				value: 'acme.cloud.looker.com',
			})
			await expect(handler.refreshToken('rt')).rejects.toThrow('302')
		} finally {
			globalThis.fetch = original
		}
		expect(seen).toHaveLength(1)
		expect(seen[0]?.redirect).toBe('manual')
	})

	it('leaves a tool at a fixed address alone: no lookup, redirects as before', async () => {
		const seen: RequestInit[] = []
		const original = globalThis.fetch
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			seen.push(init)
			return new Response(JSON.stringify({ access_token: 'at' }))
		}) as unknown as typeof fetch
		try {
			const handler = new OAuth2Handler(
				{
					authorizationUrl: 'https://provider.example/authorize',
					tokenUrl: 'https://provider.example/token',
					scopes: [],
					clientIdEnv: 'X_CLIENT_ID',
					clientSecretEnv: 'X_CLIENT_SECRET',
				},
				undefined,
				{ clientId: 'id', clientSecret: 's' },
			)
			await handler.refreshToken('rt')
		} finally {
			globalThis.fetch = original
		}
		expect(lookupMock).not.toHaveBeenCalled()
		expect(seen[0]?.redirect).toBeUndefined()
	})
})
