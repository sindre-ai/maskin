import { describe, expect, it, vi } from 'vitest'
import { actorScopedProviders } from '../../../../lib/integrations/lookup'
import { YOUTUBE_WRITE_SCOPES, config } from '../../../../lib/integrations/providers/youtube/config'
import { revokeYoutubeGrant } from '../../../../lib/integrations/providers/youtube/disconnect'
import { resolveExternalId } from '../../../../lib/integrations/providers/youtube/resolve-id'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('youtube provider config', () => {
	it('has the right name and display name', () => {
		expect(config.name).toBe('youtube')
		expect(config.displayName).toBe('YouTube')
	})

	it('requests only the read, email and openid scopes verified in round 1', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.scopes).toEqual([
			'https://www.googleapis.com/auth/youtube.readonly',
			'https://www.googleapis.com/auth/userinfo.email',
			'openid',
		])
	})

	it('asks for no scope outside the read list', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		const allowed = [
			'https://www.googleapis.com/auth/youtube.readonly',
			'https://www.googleapis.com/auth/userinfo.email',
			'openid',
		]
		for (const scope of config.auth.config.scopes) expect(allowed).toContain(scope)
		for (const scope of YOUTUBE_WRITE_SCOPES) {
			expect(config.auth.config.scopes).not.toContain(scope)
		}
	})

	it('keeps the write scopes in one named list for round 2', () => {
		expect(YOUTUBE_WRITE_SCOPES).toEqual([
			'https://www.googleapis.com/auth/youtube.force-ssl',
			'https://www.googleapis.com/auth/youtube',
			'https://www.googleapis.com/auth/youtube.upload',
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

	it('revokes and purges on disconnect', () => {
		expect(getProvider('youtube').preDisconnect).toBe(revokeYoutubeGrant)
	})

	it('has no postInstall, watch or webhook hooks', () => {
		const provider = getProvider('youtube')
		expect(provider.postInstall).toBeUndefined()
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
