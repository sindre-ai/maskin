import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEmailStopUrl } from '../../lib/email-stop-link'
import { verifyEmailStopToken } from '../../lib/email-stop-token'

const ACTOR = '3f2b8c1e-9d4a-4e6b-8a57-1c2d3e4f5a6b'

describe('buildEmailStopUrl', () => {
	afterEach(() => vi.unstubAllEnvs())

	it('points at the stop route on the app address with a token that verifies', () => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', 'unit-test-email-stop-secret-0123456789')
		const url = new URL(buildEmailStopUrl(ACTOR, { APP_URL: 'https://app.maskin.test/' }))
		expect(url.origin).toBe('https://app.maskin.test')
		expect(url.pathname).toBe('/api/email/stop')
		const verdict = verifyEmailStopToken(url.searchParams.get('token') ?? '')
		expect(verdict).toEqual({ ok: true, actorId: ACTOR, kind: null })
	})

	it('throws when the secret is not set', () => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', '')
		expect(() => buildEmailStopUrl(ACTOR, { APP_URL: 'https://app.maskin.test' })).toThrow()
	})
})
