import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getIntegrationCredential = vi.fn()
const getCredential = vi.fn()
const listYoutubeConnections = vi.fn()
const getValidToken = vi.fn()
const markRevoked = vi.fn()
const chargeYoutubeQuota = vi.fn()
const purgeYoutubeData = vi.fn()

vi.mock('../../../../lib/integrations/lookup', () => ({
	getIntegrationCredential: (...args: unknown[]) => getIntegrationCredential(...args),
	getCredential: (...args: unknown[]) => getCredential(...args),
}))
vi.mock('../../../../lib/integrations/providers/youtube/connections', () => ({
	YOUTUBE_PROVIDER: 'youtube',
	listYoutubeConnections: (...args: unknown[]) => listYoutubeConnections(...args),
}))
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidToken
		markRevoked = markRevoked
	},
}))
vi.mock('../../../../lib/integrations/providers/youtube/purge', () => ({
	purgeYoutubeData: (...args: unknown[]) => purgeYoutubeData(...args),
}))
vi.mock('../../../../lib/integrations/providers/youtube/quota', () => ({
	chargeYoutubeQuota: (...args: unknown[]) => chargeYoutubeQuota(...args),
}))

import { IntegrationAuthRevokedError } from '../../../../lib/integrations/errors'
import { clearYoutubeCache } from '../../../../lib/integrations/providers/youtube/cache'
import { youtubeRead } from '../../../../lib/integrations/providers/youtube/client'
import { logger } from '../../../../lib/logger'

const ctx = { db: {} as never, workspaceId: 'ws-1', actorId: 'actor-1' }
const read = {
	tool: 'youtube__get_channel',
	path: 'channels',
	params: { part: 'snippet', mine: 'true' },
	units: 1,
}
const CHANNEL = { items: [{ id: 'UC1', snippet: { title: 'Secret channel title' } }] }

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), { status, headers })
}

describe('youtubeRead', () => {
	beforeEach(() => {
		clearYoutubeCache()
		getIntegrationCredential.mockReset().mockResolvedValue({ id: 'int-1' })
		getCredential.mockReset()
		listYoutubeConnections
			.mockReset()
			.mockResolvedValue([{ integration_id: 'int-1', account: 'a@example.com' }])
		getValidToken.mockReset().mockResolvedValue('ya29.token')
		markRevoked.mockReset().mockResolvedValue(undefined)
		chargeYoutubeQuota.mockReset().mockResolvedValue(undefined)
		purgeYoutubeData.mockReset().mockResolvedValue(undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	it('calls youtube/v3 with the bearer token, charges the units and returns the body as is', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(CHANNEL))

		await expect(youtubeRead(ctx, read)).resolves.toEqual(CHANNEL)

		const [url, init] = fetchSpy.mock.calls[0]
		expect(String(url)).toBe(
			'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
		)
		expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer ya29.token' })
		expect(chargeYoutubeQuota).toHaveBeenCalledWith(ctx.db, 'ws-1', 1, 'data')
	})

	it('charges the bucket the read names, and a repeated search costs nothing', async () => {
		const search = {
			tool: 'youtube__search',
			path: 'search',
			params: { part: 'snippet', q: 'ai agents', type: 'video', maxResults: '10' },
			units: 1,
			bucket: 'search' as const,
		}
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

		await youtubeRead(ctx, search)
		await youtubeRead(ctx, search)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(1)
		expect(chargeYoutubeQuota).toHaveBeenCalledWith(ctx.db, 'ws-1', 1, 'search')
	})

	it('serves a repeat read from the cache at zero quota cost', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(CHANNEL))

		await youtubeRead(ctx, read)
		await expect(youtubeRead(ctx, read)).resolves.toEqual(CHANNEL)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(1)
	})

	it('checks the active integration row before the cache: a revoked row never reaches a cached read', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(CHANNEL))
		await youtubeRead(ctx, read)

		getIntegrationCredential.mockResolvedValue(null)

		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('does not share cache entries between integrations', async () => {
		// A fresh Response per call: a body can only be read once.
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => jsonResponse(CHANNEL))
		await youtubeRead(ctx, read)

		getIntegrationCredential.mockResolvedValue({ id: 'int-2' })
		await youtubeRead(ctx, read)

		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	describe('several connected accounts', () => {
		const TWO = [
			{ integration_id: 'int-1', account: 'a@example.com' },
			{ integration_id: 'int-2', account: 'b@example.com' },
		]

		it('refuses a call with no integration id and lists the connections', async () => {
			listYoutubeConnections.mockResolvedValue(TWO)
			const fetchSpy = vi.spyOn(globalThis, 'fetch')

			const err = await youtubeRead(ctx, read).catch((e) => e)

			expect(err).toMatchObject({ code: 'INTEGRATION_REQUIRED', connections: TWO })
			expect(err.toPayload().connections).toEqual(TWO)
			expect(getIntegrationCredential).not.toHaveBeenCalled()
			expect(getCredential).not.toHaveBeenCalled()
			expect(chargeYoutubeQuota).not.toHaveBeenCalled()
			expect(fetchSpy).not.toHaveBeenCalled()
		})

		it('reads the chosen connection through the Keychain and keys the cache by it', async () => {
			listYoutubeConnections.mockResolvedValue(TWO)
			getCredential.mockImplementation(async (_db, _ws, id: string) => ({ id }))
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(CHANNEL))

			await youtubeRead({ ...ctx, integrationId: 'int-2' }, read)
			await youtubeRead({ ...ctx, integrationId: 'int-2' }, read)
			await youtubeRead({ ...ctx, integrationId: 'int-1' }, read)

			expect(getCredential).toHaveBeenCalledWith(
				ctx.db,
				'ws-1',
				'int-2',
				expect.objectContaining({ requestingActorId: 'actor-1' }),
			)
			expect(getValidToken).toHaveBeenCalledWith(ctx.db, 'int-2', expect.anything())
			// int-2 twice is one Google call, int-1 is its own.
			expect(fetchSpy).toHaveBeenCalledTimes(2)
		})

		it('refuses an id that is not an active connection of this workspace', async () => {
			listYoutubeConnections.mockResolvedValue(TWO)

			await expect(
				youtubeRead({ ...ctx, integrationId: 'int-other-ws' }, read),
			).rejects.toMatchObject({
				code: 'INTEGRATION_REQUIRED',
				connections: TWO,
			})
			expect(getCredential).not.toHaveBeenCalled()
		})

		it('still accepts an explicit id when only one account is connected', async () => {
			getCredential.mockResolvedValue({ id: 'int-1' })
			vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(CHANNEL))

			await expect(youtubeRead({ ...ctx, integrationId: 'int-1' }, read)).resolves.toEqual(CHANNEL)
		})
	})

	it('marks the row revoked on a 401 and throws RECONSENT_REQUIRED', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: {} }, 401))

		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({
			code: 'RECONSENT_REQUIRED',
			providerStatus: 401,
			integrationId: 'int-1',
		})
		expect(markRevoked).toHaveBeenCalledWith(ctx.db, 'int-1')
		expect(purgeYoutubeData).toHaveBeenCalledWith(ctx.db, {
			integrationId: 'int-1',
			workspaceId: 'ws-1',
		})
	})

	it('still throws RECONSENT_REQUIRED when marking the row fails', async () => {
		vi.spyOn(logger, 'warn').mockImplementation(() => {})
		markRevoked.mockRejectedValueOnce(new Error('db down'))
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: {} }, 401))

		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({ code: 'RECONSENT_REQUIRED' })
		expect(purgeYoutubeData).toHaveBeenCalledTimes(1)
	})

	it('maps a refresh that Google rejects (invalid_grant) to RECONSENT_REQUIRED and purges', async () => {
		getValidToken.mockRejectedValueOnce(new IntegrationAuthRevokedError('int-1'))
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({ code: 'RECONSENT_REQUIRED' })
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(purgeYoutubeData).toHaveBeenCalledWith(ctx.db, {
			integrationId: 'int-1',
			workspaceId: 'ws-1',
		})
	})

	it('does not cache a read that was in flight when a purge ran', async () => {
		const { purgeYoutubeCache } = await import(
			'../../../../lib/integrations/providers/youtube/cache'
		)
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			purgeYoutubeCache('int-1')
			return jsonResponse(CHANNEL)
		})

		await youtubeRead(ctx, read)
		await youtubeRead(ctx, read)

		expect(fetchSpy).toHaveBeenCalledTimes(2)
	})

	it('does not call Google when the quota guard refuses', async () => {
		const { YoutubeError } = await import('../../../../lib/integrations/providers/youtube/errors')
		chargeYoutubeQuota.mockRejectedValueOnce(
			new YoutubeError({ code: 'WORKSPACE_QUOTA_EXHAUSTED', message: 'used up' }),
		)
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({
			code: 'WORKSPACE_QUOTA_EXHAUSTED',
		})
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('does not refund or cache a failed call', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(jsonResponse({ error: {} }, 500))
			.mockResolvedValueOnce(jsonResponse(CHANNEL))

		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
		await expect(youtubeRead(ctx, read)).resolves.toEqual(CHANNEL)

		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(2)
	})

	it('errors carry status, reason and integration id only, never the response body', async () => {
		const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
		const body = {
			error: {
				message: 'Secret channel title leaked here',
				errors: [{ reason: 'forbidden', message: 'Secret channel title leaked here' }],
			},
		}
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(body, 403))

		const err = await youtubeRead(ctx, read).catch((e) => e)

		expect(err).toMatchObject({
			code: 'PERMISSION_DENIED',
			providerStatus: 403,
			reason: 'forbidden',
			integrationId: 'int-1',
		})
		expect(JSON.stringify(err.toPayload())).not.toContain('Secret channel title')
		expect(err.message).not.toContain('Secret channel title')
		expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('Secret channel title')
	})

	it('maps a Google quotaExceeded 403 to RATE_LIMITED', async () => {
		vi.spyOn(logger, 'info').mockImplementation(() => {})
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonResponse({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403),
		)
		await expect(youtubeRead(ctx, read)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
	})

	it('turns a network failure into PROVIDER_ERROR without the underlying message', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connect ECONNRESET 1.2.3.4'))
		const err = await youtubeRead(ctx, read).catch((e) => e)
		expect(err).toMatchObject({ code: 'PROVIDER_ERROR', integrationId: 'int-1' })
		expect(err.message).not.toContain('ECONNRESET')
	})

	it('reads the credential through the Keychain, attributed to the caller', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(CHANNEL))
		await youtubeRead(ctx, read)
		expect(getIntegrationCredential).toHaveBeenCalledWith(
			ctx.db,
			'ws-1',
			'youtube',
			null,
			expect.objectContaining({
				ctx: expect.objectContaining({ requestingActorId: 'actor-1' }),
			}),
		)
	})

	it('refuses to read a credential with no authenticated caller', async () => {
		await expect(youtubeRead({ ...ctx, actorId: '' }, read)).rejects.toMatchObject({
			code: 'PERMISSION_DENIED',
		})
		expect(getIntegrationCredential).not.toHaveBeenCalled()
	})
})
