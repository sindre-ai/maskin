import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLAGS } from '../../../../../lib/feature-flags'
import { actorScopedProviders } from '../../../../../lib/integrations/lookup'
import { config } from '../../../../../lib/integrations/providers/google-drive/config'
import { resolveExternalId } from '../../../../../lib/integrations/providers/google-drive/resolve-id'
import { getProvider, listProviders } from '../../../../../lib/integrations/registry'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

describe('google-drive provider config', () => {
	it('has the spec name, display name and logo', () => {
		expect(config.name).toBe('google-drive')
		expect(config.displayName).toBe('Google Drive')
		expect(config.logoUrl).toBe('/integrations/google-drive.svg')
	})

	it('uses its own OAuth client with PKCE, offline access and the revoke URL', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		const a = config.auth.config
		expect(a.clientIdEnv).toBe('GOOGLE_DRIVE_CLIENT_ID')
		expect(a.clientSecretEnv).toBe('GOOGLE_DRIVE_CLIENT_SECRET')
		expect(a.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth')
		expect(a.tokenUrl).toBe('https://oauth2.googleapis.com/token')
		expect(a.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
		expect(a.pkce).toBe(true)
		expect(a.extraAuthParams).toMatchObject({
			access_type: 'offline',
			prompt: 'consent',
			include_granted_scopes: 'true',
		})
	})

	it('requests exactly openid + userinfo.email + drive (no drive.file / drive.readonly)', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		expect(config.auth.config.scopes).toEqual([
			'openid',
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/drive',
		])
	})

	it('MCP config: GOOGLE_DRIVE_TOKEN envKey, autoInject false, http server on the Maskin API', () => {
		expect(config.mcp?.envKey).toBe('GOOGLE_DRIVE_TOKEN')
		expect(config.mcp?.autoInject).toBe(false)
		expect(config.mcp?.server?.type).toBe('http')
		expect(config.mcp?.server?.url).toBe('${MASKIN_API_URL}/api/integrations/google-drive/mcp')
	})

	it('declares the four Drive change actions on a custom webhook', () => {
		expect(config.webhook).toEqual({ type: 'custom' })
		expect(config.events?.definitions[0]?.actions).toEqual([
			'created',
			'updated',
			'deleted',
			'trashed',
		])
	})
})

describe('google-drive registry wiring', () => {
	it('is registered with the full hook set and listed with the other providers', () => {
		const p = getProvider('google-drive')
		expect(p.config.name).toBe('google-drive')
		expect(p.resolveExternalId).toBe(resolveExternalId)
		expect(p.postInstall).toBeTypeOf('function')
		expect(p.preDisconnect).toBeTypeOf('function')
		expect(p.customWebhookVerifier).toBeTypeOf('function')
		expect(p.webhookPreHandler).toBeTypeOf('function')
		expect(p.webhookFanOut).toBeTypeOf('function')
		expect(listProviders().map((x) => x.config.name)).toContain('google-drive')
	})

	it('is workspace-scoped: NOT in actorScopedProviders', () => {
		expect(actorScopedProviders.has('google-drive')).toBe(false)
	})

	it('watch hooks are inert stubs: verifier rejects, pre-handler and fan-out do nothing', async () => {
		const p = getProvider('google-drive')
		expect(await p.customWebhookVerifier?.('{}', { 'x-goog-channel-id': 'abc' })).toBe(false)
		expect(p.webhookPreHandler?.({}, {})).toBeNull()
		expect(await p.webhookFanOut?.({} as never)).toEqual([])
	})
})

describe('feature flag', () => {
	it('registers GOOGLE_DRIVE_INTEGRATION_UI as google-drive-integration-ui', () => {
		expect(FLAGS.GOOGLE_DRIVE_INTEGRATION_UI).toBe('google-drive-integration-ui')
	})
})

describe('resolveExternalId', () => {
	afterEach(() => vi.restoreAllMocks())

	it('returns the Google account email from userinfo', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ email: 'sebk@meshfirm.com' }),
		} as Response)
		expect(await resolveExternalId({ accessToken: 'ya29.test' })).toBe('sebk@meshfirm.com')
	})

	it('throws when there is no access token', async () => {
		await expect(resolveExternalId({})).rejects.toThrow(/no access token/i)
	})
})
