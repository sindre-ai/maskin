import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	EMAIL_STOP_TTL_MS,
	signEmailStopToken,
	verifyEmailStopToken,
} from '../../lib/email-stop-token'

const SECRET = 'unit-test-email-stop-secret-0123456789abcdef'
const ACTOR = '3f1c1d7e-9a2b-4c55-8d0e-0a1b2c3d4e5f'

describe('email stop token', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', SECRET)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('accepts a token it signed', () => {
		expect(verifyEmailStopToken(signEmailStopToken(ACTOR))).toEqual({ ok: true, actorId: ACTOR })
	})

	it('rejects a token for another account or a changed expiry', () => {
		const [, expiry, sig] = signEmailStopToken(ACTOR).split('.') as [string, string, string]
		const other = '9f1c1d7e-9a2b-4c55-8d0e-0a1b2c3d4e5f'
		expect(verifyEmailStopToken(`${other}.${expiry}.${sig}`)).toEqual({
			ok: false,
			reason: 'invalid',
		})
		expect(verifyEmailStopToken(`${ACTOR}.${Number(expiry) + 1}.${sig}`)).toEqual({
			ok: false,
			reason: 'invalid',
		})
	})

	it('rejects malformed input', () => {
		for (const bad of ['', 'a.b', 'a.b.c.d', `${ACTOR}.notanumber.sig`, `${ACTOR}.1.`]) {
			expect(verifyEmailStopToken(bad).ok).toBe(false)
		}
	})

	it('rejects an expired token', () => {
		const token = signEmailStopToken(ACTOR, 1_000)
		expect(verifyEmailStopToken(token, 1_000 + EMAIL_STOP_TTL_MS - 1).ok).toBe(true)
		expect(verifyEmailStopToken(token, 1_000 + EMAIL_STOP_TTL_MS)).toEqual({
			ok: false,
			reason: 'expired',
		})
	})

	it('rejects a token signed with a different secret', () => {
		const token = signEmailStopToken(ACTOR)
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', `${SECRET}-rotated`)
		expect(verifyEmailStopToken(token)).toEqual({ ok: false, reason: 'invalid' })
	})

	it('signs and accepts nothing without a secret, or with a short one', () => {
		const token = signEmailStopToken(ACTOR)
		for (const value of ['', 'too-short']) {
			vi.stubEnv('EMAIL_STOP_LINK_SECRET', value)
			expect(() => signEmailStopToken(ACTOR)).toThrow()
			expect(verifyEmailStopToken(token)).toEqual({ ok: false, reason: 'unconfigured' })
		}
	})
})
