import { afterEach, describe, expect, it, vi } from 'vitest'
import { callGoogleApi } from '../../../../lib/integrations/providers/google-meet/client'
import { logger } from '../../../../lib/logger'

describe('callGoogleApi', () => {
	afterEach(() => vi.restoreAllMocks())

	it('logs Google status and body before throwing the normalized error', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
		const body =
			'{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}'
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body, { status: 403 }))

		await expect(
			callGoogleApi('https://workspaceevents.googleapis.com/v1/subscriptions', 'ya29.test', {
				method: 'POST',
				body: {},
			}),
		).rejects.toMatchObject({ envelope: { error: { code: 'MEETING_NOT_OWNED_BY_ACTOR' } } })

		expect(warnSpy).toHaveBeenCalledWith('Google API call failed', {
			method: 'POST',
			host: 'workspaceevents.googleapis.com',
			path: '/v1/subscriptions',
			httpStatus: 403,
			body,
		})
	})
})
