import { describe, expect, it, vi } from 'vitest'
import { actorScopedProviders } from '../../../../lib/integrations/lookup'
import { config } from '../../../../lib/integrations/providers/youtube/config'
import { resolveExternalId } from '../../../../lib/integrations/providers/youtube/resolve-id'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('youtube provider config', () => {
	it('has the right name and display name', () => {
		expect(config.name).toBe('youtube')
		expect(config.displayName).toBe('YouTube')
	})

	it('requests exactly youtube.readonly, userinfo.email and openid', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.scopes).toEqual([
			'https://www.googleapis.com/auth/youtube.readonly',
			'https://www.googleapis.com/auth/userinfo.email',
			'openid',
		])
	})

	it('sets revokeUrl, or the disconnect hook would be a silent no-op', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
	})

	it('uses PKCE and offline access but never include_granted_scopes', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.pkce).toBe(true)
		expect(config.auth.config.extraAuthParams).toEqual({
			access_type: 'offline',
			prompt: 'consent',
		})
		expect(config.auth.config.extraAuthParams).not.toHaveProperty('include_granted_scopes')
	})

	it('reads its own OAuth client from the YouTube env vars', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.clientIdEnv).toBe('GOOGLE_YOUTUBE_CLIENT_ID')
		expect(config.auth.config.clientSecretEnv).toBe('GOOGLE_YOUTUBE_CLIENT_SECRET')
	})

	it('serves a Maskin-hosted tool server that agents opt into', () => {
		expect(config.mcp?.autoInject).toBe(false)
		expect(config.mcp?.server).toMatchObject({
			type: 'http',
			url: '${MASKIN_API_URL}/api/integrations/youtube/mcp',
		})
	})

	it('shows the Google email as the connected account', () => {
		expect(config.externalIdDisplay).toBe('email')
	})

	it('has no webhook and no event definitions', () => {
		expect(config.webhook).toBeUndefined()
		expect(config.events).toBeUndefined()
	})
})

describe('youtube registry entry', () => {
	it('is registered and listed', () => {
		expect(listProviders().map((p) => p.config.name)).toContain('youtube')
		expect(getProvider('youtube').config).toBe(config)
	})

	it('has no postInstall, watch or webhook hooks', () => {
		const provider = getProvider('youtube')
		expect(provider.postInstall).toBeUndefined()
		expect(provider.preDisconnect).toBeUndefined()
		expect(provider.customWebhookVerifier).toBeUndefined()
		expect(provider.webhookFanOut).toBeUndefined()
	})

	it('is workspace-scoped, not actor-scoped', () => {
		expect(actorScopedProviders.has('youtube')).toBe(false)
	})
})

describe('youtube resolveExternalId', () => {
	it('returns the Google account email', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ email: 'owner@example.com' }), { status: 200 }),
		)
		await expect(resolveExternalId({ accessToken: 'ya29.test' } as never)).resolves.toBe(
			'owner@example.com',
		)
	})

	it('throws without an access token', async () => {
		await expect(resolveExternalId({} as never)).rejects.toThrow(/no access token/)
	})
})
