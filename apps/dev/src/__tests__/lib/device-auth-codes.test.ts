import { USER_CODE_ALPHABET, USER_CODE_LENGTH, normalizeUserCode } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { generateDeviceCode, generateUserCode, hashCode } from '../../lib/device-auth-codes'
import { createWindowLimiter } from '../../lib/fixed-window-limiter'

describe('device-auth codes', () => {
	it('mints user codes from the alphabet that normalize cleanly', () => {
		for (let i = 0; i < 200; i++) {
			const code = generateUserCode()
			expect(code).toHaveLength(USER_CODE_LENGTH)
			expect([...code].every((ch) => USER_CODE_ALPHABET.includes(ch))).toBe(true)
			expect(normalizeUserCode(code)).toBe(code)
		}
	})

	it('mints device codes that are long, url-safe and different every time', () => {
		const a = generateDeviceCode()
		const b = generateDeviceCode()
		expect(a).not.toBe(b)
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	it('hashes deterministically without leaking the code', () => {
		expect(hashCode('BCDF2345')).toBe(hashCode('BCDF2345'))
		expect(hashCode('BCDF2345')).not.toBe(hashCode('BCDF2346'))
		expect(hashCode('BCDF2345')).toMatch(/^[0-9a-f]{64}$/)
		expect(hashCode('BCDF2345')).not.toContain('BCDF2345')
	})
})

describe('fixed-window limiter', () => {
	it('allows up to the limit, then refuses until the window passes', () => {
		const limiter = createWindowLimiter({ limit: 2, windowMs: 1000 })
		expect(limiter.hit('ip', 0).allowed).toBe(true)
		expect(limiter.hit('ip', 10).allowed).toBe(true)
		const third = limiter.hit('ip', 20)
		expect(third.allowed).toBe(false)
		expect(third.retryAfterMs).toBe(980)
		expect(limiter.hit('ip', 1000).allowed).toBe(true)
	})

	it('counts keys separately', () => {
		const limiter = createWindowLimiter({ limit: 1, windowMs: 1000 })
		expect(limiter.hit('a', 0).allowed).toBe(true)
		expect(limiter.hit('b', 0).allowed).toBe(true)
		expect(limiter.hit('a', 1).allowed).toBe(false)
	})

	it('stays bounded under a flood of distinct keys', () => {
		const limiter = createWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 50 })
		for (let i = 0; i < 500; i++) expect(limiter.hit(`k${i}`, i).allowed).toBe(true)
	})
})
