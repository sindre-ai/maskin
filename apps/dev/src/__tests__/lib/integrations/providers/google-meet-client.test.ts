import { afterEach, describe, expect, it, vi } from 'vitest'
import { callGoogleApi } from '../../../../lib/integrations/providers/google-meet/client'
import { logger } from '../../../../lib/logger'

describe('callGoogleApi 403 logging', () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it('logs the endpoint and Google body on 403, and still throws the normalized error', async () => {
		const body = '{"error":{"code":403,"message":"Permission denied on Pub/Sub topic"}}'
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 403 })))
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		await expect(
			callGoogleApi('https://workspaceevents.googleapis.com/v1/subscriptions', 'tok', {
				method: 'POST',
				body: {},
			}),
		).rejects.toMatchObject({
			envelope: { error: { code: 'MEETING_NOT_OWNED_BY_ACTOR', provider_status: 403 } },
		})

		expect(warnSpy).toHaveBeenCalledWith('Google API returned 403', {
			method: 'POST',
			endpoint: 'workspaceevents.googleapis.com/v1/subscriptions',
			body,
		})
	})

	it('does not log for other failures', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })))
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		await expect(callGoogleApi('https://meet.googleapis.com/v2/x', 'tok')).rejects.toBeDefined()
		expect(warnSpy).not.toHaveBeenCalled()
	})
})
