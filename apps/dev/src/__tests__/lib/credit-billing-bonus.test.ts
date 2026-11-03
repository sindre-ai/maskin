import { describe, expect, it } from 'vitest'
import {
	GROWTH_BONUS,
	GROWTH_THRESHOLD_USD_MINOR,
	SCALE_BONUS,
	SCALE_THRESHOLD_USD_MINOR,
	bonusFor,
	normalizeToUsdMinor,
} from '../../lib/credit-billing'

// Test approach item 10 (spec): custom-amount volume bonus — submit amounts
// across the tier boundaries and assert bonusFor returns 0 / 0.10 / 0.20 in
// each currency. Also validates the fixed FX reference ($50 = 349 DKK = 45
// EUR) — those numbers are load-bearing per the 7 Sep Pricing lock-down.

describe('normalizeToUsdMinor', () => {
	it('is the identity on USD', () => {
		expect(normalizeToUsdMinor(1_000, 'usd')).toBe(1_000)
		expect(normalizeToUsdMinor(0, 'usd')).toBe(0)
	})

	it('converts DKK using the fixed $50 = 349 DKK reference', () => {
		// $50 = 349 DKK → 34900 DKK-minor should normalise to 5000 USD-minor.
		expect(normalizeToUsdMinor(34_900, 'dkk')).toBe(5_000)
	})

	it('converts EUR using the fixed $50 = 45 EUR reference', () => {
		// $50 = 45 EUR → 4500 EUR-minor should normalise to 5000 USD-minor.
		expect(normalizeToUsdMinor(4_500, 'eur')).toBe(5_000)
	})

	it('rejects non-finite / non-positive input', () => {
		expect(normalizeToUsdMinor(0, 'eur')).toBe(0)
		expect(normalizeToUsdMinor(-10, 'usd')).toBe(0)
		expect(normalizeToUsdMinor(Number.NaN, 'usd')).toBe(0)
	})
})

describe('bonusFor (Delta 1b tiers — Scale-first)', () => {
	it('returns 0 below the Growth threshold in USD', () => {
		expect(bonusFor(GROWTH_THRESHOLD_USD_MINOR - 1, 'usd')).toBe(0)
		expect(bonusFor(0, 'usd')).toBe(0)
	})

	it('returns 0.10 exactly at and above Growth, below Scale (USD)', () => {
		expect(bonusFor(GROWTH_THRESHOLD_USD_MINOR, 'usd')).toBe(GROWTH_BONUS)
		expect(bonusFor(SCALE_THRESHOLD_USD_MINOR - 1, 'usd')).toBe(GROWTH_BONUS)
	})

	it('returns 0.20 exactly at and above Scale (USD)', () => {
		expect(bonusFor(SCALE_THRESHOLD_USD_MINOR, 'usd')).toBe(SCALE_BONUS)
		expect(bonusFor(SCALE_THRESHOLD_USD_MINOR * 10, 'usd')).toBe(SCALE_BONUS)
	})

	it('scale-first — a Scale-tier top-up is NOT misclassified as Growth', () => {
		// This is the exact regression the 7 Sep Pricing lock-down comment
		// spelled out: a naive "check Growth first" order returns 0.10 on a
		// Scale-tier amount because usdEquivMinor >= GROWTH also holds. Guard
		// with a boundary amount that is unambiguously Scale.
		const scaleTier = SCALE_THRESHOLD_USD_MINOR
		expect(scaleTier).toBeGreaterThan(GROWTH_THRESHOLD_USD_MINOR) // sanity
		expect(bonusFor(scaleTier, 'usd')).toBe(SCALE_BONUS)
	})

	it('DKK amounts cross the tiers at the fixed-reference boundary', () => {
		// $250 = 1745 DKK ≈ 174500 DKK-minor, $1000 = 6980 DKK = 698000 DKK-minor.
		// Round-trip through Math.round(N*5000/34900), so use amounts a few DKK
		// off the boundary to sidestep sub-cent rounding at the exact point.
		expect(bonusFor(170_000, 'dkk')).toBe(0)
		expect(bonusFor(175_000, 'dkk')).toBe(GROWTH_BONUS)
		expect(bonusFor(690_000, 'dkk')).toBe(GROWTH_BONUS)
		expect(bonusFor(700_000, 'dkk')).toBe(SCALE_BONUS)
	})

	it('EUR amounts cross the tiers at the fixed-reference boundary', () => {
		// $250 = 225 EUR = 22500 EUR-minor, $1000 = 900 EUR = 90000 EUR-minor.
		// Exact multiples of 5 EUR-cent line up cleanly with the $50 = 45 EUR
		// reference (5000 / 4500 ratio).
		expect(bonusFor(22_000, 'eur')).toBe(0)
		expect(bonusFor(22_500, 'eur')).toBe(GROWTH_BONUS)
		expect(bonusFor(89_500, 'eur')).toBe(GROWTH_BONUS)
		expect(bonusFor(90_000, 'eur')).toBe(SCALE_BONUS)
	})
})
