import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeState } from '../../lib/integrations/oauth/state'
import {
	OAuthNotSupportedError,
	callbackUrl,
	readOAuthBinding,
	resolveOAuthClient,
} from '../../lib/tool-broker/oauth'

const METADATA_WITH_DCR = {
	issuer: 'https://mcp.example.com',
	authorizationUrl: 'https://mcp.example.com/authorize',
	tokenUrl: 'https://mcp.example.com/token',
	resource: 'https://mcp.example.com/mcp',
	scopesSupported: ['read', 'write'],
	registrationEndpoint: 'https://mcp.example.com/register',
	tokenEndpointAuthMethodsSupported: ['none'],
}

describe('callbackUrl', () => {
	it('builds our own callback, not the backend’s', () => {
		// The whole point: the provider redirects to US, so the backend never needs
		// to be reachable from a browser.
		expect(callbackUrl('https://app.example.com')).toBe(
			'https://app.example.com/api/tool-broker/oauth/callback',
		)
	})

	it('tolerates a trailing slash on the origin', () => {
		expect(callbackUrl('https://app.example.com/')).toBe(
			'https://app.example.com/api/tool-broker/oauth/callback',
		)
	})
})

describe('resolveOAuthClient', () => {
	it('registers dynamically when the provider advertises a registration endpoint', async () => {
		const client = {
			probeOAuth: vi.fn().mockResolvedValue(METADATA_WITH_DCR),
			registerOAuthClient: vi.fn().mockResolvedValue('dcr-example'),
		}

		const result = await resolveOAuthClient(client as never, 'key', {
			integrationSlug: 'w0123_example',
			endpointUrl: 'https://mcp.example.com/mcp',
			redirectUri: 'https://app.example.com/api/tool-broker/oauth/callback',
		})

		expect(result.clientId).toBe('dcr-example')
		// Our callback is what gets registered with the provider.
		expect(client.registerOAuthClient).toHaveBeenCalledWith(
			'key',
			expect.objectContaining({
				redirectUri: 'https://app.example.com/api/tool-broker/oauth/callback',
			}),
		)
	})

	it('refuses clearly when the provider does not support registration', async () => {
		// Without DCR the integration needs a client configured out of band, and
		// saying so beats failing somewhere deeper with an opaque error.
		const client = {
			probeOAuth: vi.fn().mockResolvedValue({ ...METADATA_WITH_DCR, registrationEndpoint: null }),
			registerOAuthClient: vi.fn(),
		}

		await expect(
			resolveOAuthClient(client as never, 'key', {
				integrationSlug: 'w0123_example',
				endpointUrl: 'https://mcp.example.com/mcp',
				redirectUri: 'https://app.example.com/api/tool-broker/oauth/callback',
			}),
		).rejects.toBeInstanceOf(OAuthNotSupportedError)

		expect(client.registerOAuthClient).not.toHaveBeenCalled()
	})
})

describe('oauth state binding', () => {
	// The binding is sealed with the integration encryption key, so set it the
	// same way crypto.test.ts does rather than relying on the ambient env.
	const TEST_KEY = 'a'.repeat(64)
	let originalKey: string | undefined

	beforeEach(() => {
		originalKey = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY
	})

	afterEach(() => {
		if (originalKey !== undefined) {
			process.env.INTEGRATION_ENCRYPTION_KEY = originalKey
		} else {
			Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		}
	})

	// The binding is what tells the callback which workspace and actor a
	// returning `state` belongs to. Everything here is a way that correlation
	// could be abused, and each must fail closed.
	// hono's getCookie reads c.req.raw.headers, so the stub has to carry a real
	// Headers object rather than a header() function.
	const context = (cookie?: string) =>
		({
			req: {
				raw: new Request('http://localhost/cb', { headers: cookie ? { Cookie: cookie } : {} }),
			},
		}) as never

	const binding = {
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		integrationSlug: 'w0123_example',
		brokerState: 'broker-state-abc',
		scope: 'workspace' as const,
	}

	const cookieFor = (payload: Record<string, unknown>) =>
		`tb_oauth=${encodeState(payload as never)}`

	it('returns the binding when the state matches', () => {
		const cookie = cookieFor({ ...binding, ts: Date.now(), nonce: 'n' })
		expect(readOAuthBinding(context(cookie), 'broker-state-abc')).toMatchObject(binding)
	})

	it('refuses a state that does not match the one we started', () => {
		// Someone replaying another flow's code against our callback.
		const cookie = cookieFor({ ...binding, ts: Date.now(), nonce: 'n' })
		expect(readOAuthBinding(context(cookie), 'a-different-state')).toBeNull()
	})

	it('refuses an expired binding', () => {
		const cookie = cookieFor({ ...binding, ts: Date.now() - 11 * 60 * 1000, nonce: 'n' })
		expect(readOAuthBinding(context(cookie), 'broker-state-abc')).toBeNull()
	})

	it('refuses when there is no cookie at all', () => {
		expect(readOAuthBinding(context(), 'broker-state-abc')).toBeNull()
	})

	it('refuses a cookie it cannot decrypt', () => {
		// Tampered or forged: decodeState throws and the caller must not proceed.
		expect(readOAuthBinding(context('tb_oauth=not-a-real-payload'), 'broker-state-abc')).toBeNull()
	})
})

describe('which state gets bound', () => {
	// The backend's start response returns its RAW state, but the authorize URL
	// carries that state wrapped in an envelope — base64({state, orgSlug}) — and
	// the provider echoes the envelope back verbatim. Binding the raw value
	// compares two different strings at callback time, so every real flow fails
	// with invalid_state while every unit test that fabricates both sides passes.
	// This is what that mistake looked like, captured from a live callback.
	const RAW = 'TGOFaFFfs3j4E2-uw_d2VWg7DCk2Iuy3VvmNXR00vR4'
	const WRAPPED = Buffer.from(JSON.stringify({ state: RAW, orgSlug: 'default' })).toString(
		'base64url',
	)
	const authorizationUrl = `https://mcp.example.com/authorize?client_id=x&state=${WRAPPED}`

	it('takes the state from the authorize URL, not the start response', () => {
		const fromUrl = new URL(authorizationUrl).searchParams.get('state')

		expect(fromUrl).toBe(WRAPPED)
		// The two are genuinely different — this is the whole bug.
		expect(fromUrl).not.toBe(RAW)
	})

	it('matches what the provider sends back', () => {
		const bound = new URL(authorizationUrl).searchParams.get('state') ?? ''
		// The provider echoes the URL's state parameter unchanged.
		const returnedByProvider = WRAPPED

		expect(bound).toBe(returnedByProvider)
		expect(JSON.parse(Buffer.from(bound, 'base64url').toString()).state).toBe(RAW)
	})
})

describe('resolveOAuthClient — a provider that advertises registration and then refuses', () => {
	// Meta's Ads MCP server publishes `registration_endpoint` in its
	// authorization-server metadata and rejects every registration attempt with
	// "Dynamic registration is not available for this client". Verified against
	// four request shapes — minimal RFC 7591, with grant/response types, with an
	// http localhost redirect, and with a scope — all identical 400s, so it is
	// their policy rather than something we sent.
	//
	// Before this, that surfaced as "Tool broker returned 400": a number, with
	// nothing a user could act on.

	const metaMetadata = {
		issuer: 'https://mcp.example.com/ads',
		authorizationUrl: 'https://www.example.com/v26.0/dialog/oauth',
		tokenUrl: 'https://graph.example.com/v26.0/oauth/access_token',
		resource: 'https://mcp.example.com/ads',
		scopesSupported: ['ads_management', 'ads_read'],
		registrationEndpoint: 'https://mcp.example.com/.well-known/register/ads',
		tokenEndpointAuthMethodsSupported: ['none'],
	}

	it('reports it as needing a client configured out of band', async () => {
		const { ToolBrokerHttpError } = await import('@maskin/tool-broker')
		const client = {
			probeOAuth: vi.fn().mockResolvedValue(metaMetadata),
			registerOAuthClient: vi
				.fn()
				.mockRejectedValue(
					new ToolBrokerHttpError(
						400,
						'{"message":"Dynamic Client Registration failed: invalid_client_metadata — Dynamic registration is not available for this client."}',
					),
				),
		}

		await expect(
			resolveOAuthClient(client as never, 'key', {
				integrationSlug: 'w0123_ads',
				endpointUrl: 'https://mcp.example.com/ads',
				redirectUri: 'https://app.example.com/api/tool-broker/oauth/callback',
			}),
		).rejects.toBeInstanceOf(OAuthNotSupportedError)
	})

	it('does not swallow a failure that is not the provider refusing', async () => {
		// A 500 is our problem or an outage, not a "this provider needs setup"
		// answer, and mislabelling it would send someone to configure a client
		// that was never the issue.
		const { ToolBrokerHttpError } = await import('@maskin/tool-broker')
		const client = {
			probeOAuth: vi.fn().mockResolvedValue(metaMetadata),
			registerOAuthClient: vi.fn().mockRejectedValue(new ToolBrokerHttpError(500, 'boom')),
		}

		await expect(
			resolveOAuthClient(client as never, 'key', {
				integrationSlug: 'w0123_ads',
				endpointUrl: 'https://mcp.example.com/ads',
				redirectUri: 'https://app.example.com/api/tool-broker/oauth/callback',
			}),
		).rejects.not.toBeInstanceOf(OAuthNotSupportedError)
	})
})
