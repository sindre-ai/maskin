import { describe, expect, it } from 'vitest'
import { FLAGS } from '../../../../lib/feature-flags'
import {
	CustomerValueError,
	fillCustomerValue,
	validateCustomerValue,
} from '../../../../lib/integrations/customer-value'
import { GATEWAY_PROVIDERS } from '../../../../lib/integrations/mcp-gateway'
import { OAuth2Handler } from '../../../../lib/integrations/oauth/handler'
import { config as zendesk } from '../../../../lib/integrations/providers/zendesk/config'
import { getProvider } from '../../../../lib/integrations/registry'
import type { OAuth2Config } from '../../../../lib/integrations/types'

function oauth(): OAuth2Config {
	if (zendesk.auth.type !== 'oauth2') throw new Error('not oauth2')
	return zendesk.auth.config
}

describe('Zendesk provider config', () => {
	it('signs in on the customer subdomain with no scope and the app the customer pasted', () => {
		const auth = oauth()
		expect(auth.authorizationUrl).toBe('https://{value}/oauth/authorizations/new')
		expect(auth.tokenUrl).toBe('https://{value}/oauth/tokens')
		// The vendor page says to leave the allowed scopes blank, so none is asked for.
		expect(auth.scopes).toEqual([])
		expect(auth.tokenAuthMethod).toBe('client_secret_post')
		expect(auth.customerApp).toBe(true)
		expect(auth.customerValue?.kind).toBe('host')
		expect(auth.customerValue?.hostSuffixes).toEqual(['zendesk.com'])
	})

	it('serves the MCP server on the customer subdomain, with a bearer token', () => {
		expect(zendesk.mcp?.server).toEqual({
			type: 'http',
			url: 'https://{value}/mcp',
			headers: { Authorization: 'Bearer ${ZENDESK_TOKEN}' },
		})
		expect(zendesk.mcp?.envKey).toBe('ZENDESK_TOKEN')
	})

	it('is registered, behind the customer-app-tools flag, and counted by the gateway', () => {
		expect(getProvider('zendesk').config).toBe(zendesk)
		expect(GATEWAY_PROVIDERS.has('zendesk')).toBe(true)
		expect(FLAGS.CUSTOMER_APP_TOOLS).toBe('customer-app-tools')
	})
})

describe('Zendesk address', () => {
	const spec = () => {
		const v = oauth().customerValue
		if (!v) throw new Error('no customer value')
		return v
	}

	it('accepts a zendesk.com address and builds the sign-in, token and server addresses', () => {
		expect(validateCustomerValue(spec(), ' Acme.Zendesk.com ')).toBe('acme.zendesk.com')
		expect(fillCustomerValue(oauth().authorizationUrl, spec(), 'acme.zendesk.com')).toBe(
			'https://acme.zendesk.com/oauth/authorizations/new',
		)
		expect(fillCustomerValue(oauth().tokenUrl, spec(), 'acme.zendesk.com')).toBe(
			'https://acme.zendesk.com/oauth/tokens',
		)
		expect(fillCustomerValue('https://{value}/mcp', spec(), 'acme.zendesk.com')).toBe(
			'https://acme.zendesk.com/mcp',
		)
	})

	it.each([
		['a custom (host-mapped) domain', 'support.acme.com'],
		['a look-alike domain', 'acme.zendesk.com.evil.example'],
		['a look-alike without the dot', 'evilzendesk.com'],
		['the bare vendor domain', 'zendesk.com'],
		['a scheme', 'https://acme.zendesk.com'],
		['a path', 'acme.zendesk.com/mcp'],
		['a port', 'acme.zendesk.com:8443'],
		['credentials in the address', 'user@acme.zendesk.com'],
		['an IP address', '169.254.169.254'],
		['localhost', 'localhost'],
	])('refuses %s', (_name, value) => {
		expect(() => validateCustomerValue(spec(), value)).toThrow(CustomerValueError)
	})

	it('refuses to sign in at a saved value that no longer passes the check', () => {
		const handler = new OAuth2Handler(oauth(), undefined, {
			clientId: 'client-id',
			clientSecret: 's3cr3t',
			value: 'acme.evil.example',
		})
		expect(() => handler.createAuthorizationUrl('state', 'https://app/cb')).toThrow()
	})

	it('signs in on the saved subdomain and asks for no scope', () => {
		const handler = new OAuth2Handler(oauth(), undefined, {
			clientId: 'client-id',
			clientSecret: 's3cr3t',
			value: 'acme.zendesk.com',
		})
		const url = new URL(handler.createAuthorizationUrl('state', 'https://app/cb'))
		expect(url.origin + url.pathname).toBe('https://acme.zendesk.com/oauth/authorizations/new')
		expect(url.searchParams.get('client_id')).toBe('client-id')
		expect(url.searchParams.has('scope')).toBe(false)
	})
})
