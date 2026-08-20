import { describe, expect, it } from 'vitest'
import { CREDIT_TOKENS_PER_USD_CENT, tokensToCreditCents } from '../../lib/billing-defaults'

describe('tokensToCreditCents', () => {
	it('converts an exact multiple of the rate with no rounding', () => {
		expect(tokensToCreditCents(CREDIT_TOKENS_PER_USD_CENT)).toBe(1)
		expect(tokensToCreditCents(CREDIT_TOKENS_PER_USD_CENT * 5)).toBe(5)
	})

	it('rounds up any remainder — Maskin never under-charges a fractional cent', () => {
		expect(tokensToCreditCents(1)).toBe(1)
		expect(tokensToCreditCents(CREDIT_TOKENS_PER_USD_CENT + 1)).toBe(2)
	})

	it('returns 0 for 0 tokens', () => {
		expect(tokensToCreditCents(0)).toBe(0)
	})
})
