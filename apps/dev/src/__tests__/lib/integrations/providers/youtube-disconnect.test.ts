import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const purgeYoutubeData = vi.fn()
vi.mock('../../../../lib/integrations/providers/youtube/purge', () => ({
	purgeYoutubeData: (...args: unknown[]) => purgeYoutubeData(...args),
}))

import { revokeYoutubeGrant } from '../../../../lib/integrations/providers/youtube/disconnect'
import type { PreDisconnectContext } from '../../../../lib/integrations/types'
import { logger } from '../../../../lib/logger'

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

function context(credentials: PreDisconnectContext['credentials']): PreDisconnectContext {
	return {
		db: { marker: 'db' },
		integrationId: 'int-1',
		workspaceId: 'ws-1',
		credentials,
		externalId: 'person@example.com',
	}
}

function tokenSentTo(fetchSpy: ReturnType<typeof vi.spyOn>): string | null {
	const [, init] = fetchSpy.mock.calls[0] as [unknown, RequestInit]
	return new URLSearchParams(String(init.body)).get('token')
}

describe('revokeYoutubeGrant', () => {
	beforeEach(() => {
		purgeYoutubeData.mockReset().mockResolvedValue(undefined)
		vi.stubEnv('GOOGLE_YOUTUBE_CLIENT_ID', 'client-id')
		vi.stubEnv('GOOGLE_YOUTUBE_CLIENT_SECRET', 'client-secret')
		vi.spyOn(logger, 'info').mockImplementation(() => {})
		vi.spyOn(logger, 'warn').mockImplementation(() => {})
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it('posts the refresh token to the revoke URL', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

		await revokeYoutubeGrant(context({ accessToken: 'at-1', refreshToken: 'rt-1' }))

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(String(fetchSpy.mock.calls[0][0])).toBe(REVOKE_URL)
		expect(tokenSentTo(fetchSpy)).toBe('rt-1')
	})

	it('falls back to the access token when no refresh token is stored', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

		await revokeYoutubeGrant(context({ accessToken: 'at-1' }))

		expect(tokenSentTo(fetchSpy)).toBe('at-1')
	})

	it('swallows a 500 and still purges', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }))

		await expect(
			revokeYoutubeGrant(context({ accessToken: 'at-1', refreshToken: 'rt-1' })),
		).resolves.toBeUndefined()

		expect(logger.warn).toHaveBeenCalledWith(
			'YouTube revoke failed (continuing with disconnect)',
			expect.objectContaining({ integrationId: 'int-1', status: 500 }),
		)
		expect(purgeYoutubeData).toHaveBeenCalledTimes(1)
	})

	it('does not put the Google response body in the log', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('secret-body', { status: 500 }))

		await revokeYoutubeGrant(context({ accessToken: 'at-1', refreshToken: 'rt-1' }))

		expect(JSON.stringify((logger.warn as unknown as { mock: unknown }).mock)).not.toContain(
			'secret-body',
		)
	})

	it('does nothing at Google without a token, warns, and goes straight to the purge', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await revokeYoutubeGrant(context({}))

		expect(fetchSpy).not.toHaveBeenCalled()
		expect(logger.warn).toHaveBeenCalledWith('YouTube disconnect: no token to revoke', {
			integrationId: 'int-1',
		})
		expect(purgeYoutubeData).toHaveBeenCalledTimes(1)
	})

	it('treats a 400 invalid_token reply as success: info log, no warning', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 }),
		)

		await revokeYoutubeGrant(context({ accessToken: 'at-1', refreshToken: 'rt-1' }))

		expect(logger.info).toHaveBeenCalledWith('YouTube grant was already revoked at Google', {
			integrationId: 'int-1',
		})
		expect(logger.warn).not.toHaveBeenCalled()
		expect(purgeYoutubeData).toHaveBeenCalledTimes(1)
	})

	it('warns on a 400 that is not invalid_token', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 }),
		)

		await revokeYoutubeGrant(context({ refreshToken: 'rt-1' }))

		expect(logger.warn).toHaveBeenCalledWith(
			'YouTube revoke failed (continuing with disconnect)',
			expect.objectContaining({ status: 400 }),
		)
	})

	it('still purges when fetch rejects', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'))

		await expect(revokeYoutubeGrant(context({ refreshToken: 'rt-1' }))).resolves.toBeUndefined()

		expect(purgeYoutubeData).toHaveBeenCalledTimes(1)
	})

	it('purges with the integration id and workspace id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
		const ctx = context({ refreshToken: 'rt-1' })

		await revokeYoutubeGrant(ctx)

		expect(purgeYoutubeData).toHaveBeenCalledWith(ctx.db, {
			integrationId: 'int-1',
			workspaceId: 'ws-1',
		})
	})

	it('never throws, even when the purge does', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
		purgeYoutubeData.mockRejectedValue(new Error('db down'))

		await expect(revokeYoutubeGrant(context({ refreshToken: 'rt-1' }))).resolves.toBeUndefined()
	})
})
