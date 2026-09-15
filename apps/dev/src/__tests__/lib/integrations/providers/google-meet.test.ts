import { afterEach, describe, expect, it, vi } from 'vitest'
import { actorScopedProviders } from '../../../../lib/integrations/lookup'
import { config } from '../../../../lib/integrations/providers/google-meet/config'
import {
	resolveExternalId,
	resolveMeetPeopleId,
} from '../../../../lib/integrations/providers/google-meet/resolve-id'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'

describe('google-meet provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('google-meet')
		expect(config.displayName).toBe('Google Meet')
	})

	it('uses its own OAuth client (not shared with Gmail/GCal)', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.clientIdEnv).toBe('GOOGLE_MEET_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('GOOGLE_MEET_CLIENT_SECRET')
		}
	})

	it('uses OAuth2 with PKCE and offline access', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth')
		expect(config.auth.config.tokenUrl).toBe('https://oauth2.googleapis.com/token')
		expect(config.auth.config.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
		expect(config.auth.config.pkce).toBe(true)
		expect(config.auth.config.extraAuthParams).toMatchObject({
			access_type: 'offline',
			prompt: 'consent',
			include_granted_scopes: 'true',
		})
	})

	it('requests only the four locked scopes — openid + userinfo.email + meetings.space.readonly + meetings.space.created', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.scopes).toEqual([
			'openid',
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/meetings.space.readonly',
			'https://www.googleapis.com/auth/meetings.space.created',
		])
	})

	it('deliberately excludes directory.readonly (CTO 2026-09-10 deferral)', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2 auth type')
		expect(config.auth.config.scopes).not.toContain(
			'https://www.googleapis.com/auth/directory.readonly',
		)
	})

	it('uses custom webhook type for Workspace Events / Pub/Sub push', () => {
		expect(config.webhook).toEqual({ type: 'custom' })
	})

	it('defines meet.conference / transcript / recording event surfaces', () => {
		const types = config.events?.definitions.map((d) => d.entityType)
		expect(types).toEqual(
			expect.arrayContaining(['meet.conference', 'meet.transcript', 'meet.recording']),
		)
		expect(
			config.events?.definitions.find((d) => d.entityType === 'meet.conference')?.actions,
		).toContain('ended')
		expect(
			config.events?.definitions.find((d) => d.entityType === 'meet.transcript')?.actions,
		).toContain('ready')
		expect(
			config.events?.definitions.find((d) => d.entityType === 'meet.recording')?.actions,
		).toContain('ready')
	})

	it('exposes GOOGLE_MEET_TOKEN as MCP envKey with autoInject:false', () => {
		expect(config.mcp?.envKey).toBe('GOOGLE_MEET_TOKEN')
		expect(config.mcp?.autoInject).toBe(false)
		expect(config.mcp?.server?.type).toBe('http')
	})

	it('renders external id as an email', () => {
		expect(config.externalIdDisplay).toBe('email')
	})
})

describe('google-meet registry wiring', () => {
	it('is discoverable via getProvider', () => {
		const provider = getProvider('google-meet')
		expect(provider.config.name).toBe('google-meet')
		expect(provider.resolveExternalId).toBe(resolveExternalId)
		expect(provider.postInstall).toBeTypeOf('function')
	})

	it('is listed alongside every other provider', () => {
		const names = listProviders().map((p) => p.config.name)
		expect(names).toContain('google-meet')
	})

	it('is NOT in actorScopedProviders — Meet stays workspace-scoped like Gmail / GCal', () => {
		expect(actorScopedProviders.has('google-meet')).toBe(false)
	})
})

describe('resolveExternalId', () => {
	afterEach(() => vi.restoreAllMocks())

	it('returns email from Google userinfo', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ email: 'sebk@meshfirm.com' }),
		} as Response)

		const id = await resolveExternalId({ accessToken: 'ya29.a0test' })
		expect(id).toBe('sebk@meshfirm.com')
	})

	it('throws when no access token is stored', async () => {
		await expect(resolveExternalId({})).rejects.toThrow(/no access token/i)
	})
})

describe('resolveMeetPeopleId', () => {
	afterEach(() => vi.restoreAllMocks())

	it('extracts metadata.sources[0].id from a People.get(me) response', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			text: () => Promise.resolve(''),
			json: () =>
				Promise.resolve({
					resourceName: 'people/c123456789',
					metadata: { sources: [{ type: 'PROFILE', id: '123456789' }] },
				}),
		} as Response)

		const peopleId = await resolveMeetPeopleId('ya29.a0test')

		expect(peopleId).toBe('123456789')
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://people.googleapis.com/v1/people/me?personFields=metadata',
			expect.objectContaining({
				headers: { Authorization: 'Bearer ya29.a0test' },
			}),
		)
	})

	it('throws when metadata.sources is empty', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			text: () => Promise.resolve(''),
			json: () => Promise.resolve({ metadata: { sources: [] } }),
		} as Response)

		await expect(resolveMeetPeopleId('ya29.a0test')).rejects.toThrow(/metadata\.sources/)
	})

	it('throws when the People API responds non-2xx', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 403,
			text: () => Promise.resolve('PERMISSION_DENIED'),
			json: () => Promise.resolve({}),
		} as Response)

		await expect(resolveMeetPeopleId('ya29.a0test')).rejects.toThrow(/HTTP 403/)
	})
})
