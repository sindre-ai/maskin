import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	buildEmailPickDismissUrl,
	signEmailPickToken,
	verifyEmailPickToken,
} from '../../lib/email-pick-token'
import { signEmailStopToken } from '../../lib/email-stop-token'

const SECRET = 'unit-test-email-stop-secret-0123456789abcdef'
const ACTOR = '3f1c1d7e-9a2b-4c55-8d0e-0a1b2c3d4e5f'
const LOOP = '7a7a7a7a-1111-4222-8333-444455556666'

describe('email pick token', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', SECRET)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('accepts a token it signed and names the account and the flow', () => {
		expect(verifyEmailPickToken(signEmailPickToken(ACTOR, LOOP))).toEqual({
			ok: true,
			actorId: ACTOR,
			loopId: LOOP,
		})
	})

	it('rejects a changed flow, account or expiry', () => {
		const [, , expiry, sig] = signEmailPickToken(ACTOR, LOOP).split('.') as string[]
		const other = '9f1c1d7e-9a2b-4c55-8d0e-0a1b2c3d4e5f'
		for (const bad of [
			`${ACTOR}.${other}.${expiry}.${sig}`,
			`${other}.${LOOP}.${expiry}.${sig}`,
			`${ACTOR}.${LOOP}.${Number(expiry) + 1}.${sig}`,
		]) {
			expect(verifyEmailPickToken(bad)).toEqual({ ok: false, reason: 'invalid' })
		}
	})

	it('does not accept a stop-link token, and the stop link does not accept a pick token', () => {
		expect(verifyEmailPickToken(signEmailStopToken(ACTOR)).ok).toBe(false)
	})

	it('expires', () => {
		const old = signEmailPickToken(ACTOR, LOOP, Date.now() - 400 * 24 * 3600_000)
		expect(verifyEmailPickToken(old)).toEqual({ ok: false, reason: 'expired' })
	})

	it('refuses everything without a secret', () => {
		const token = signEmailPickToken(ACTOR, LOOP)
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', '')
		expect(verifyEmailPickToken(token)).toEqual({ ok: false, reason: 'unconfigured' })
		expect(() => signEmailPickToken(ACTOR, LOOP)).toThrow()
	})

	it('builds the public dismiss link', () => {
		const url = new URL(buildEmailPickDismissUrl(ACTOR, LOOP, { APP_URL: 'https://maskin.io/' }))
		expect(url.origin + url.pathname).toBe('https://maskin.io/api/email/pick-dismiss')
		expect(verifyEmailPickToken(url.searchParams.get('token') ?? '').ok).toBe(true)
	})
})
