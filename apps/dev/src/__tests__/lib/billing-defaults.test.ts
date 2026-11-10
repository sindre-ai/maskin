import { INCLUDED_USAGE_DKK, dkkToUsdCents } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { MAX_ENV_CAP, parsePositiveIntEnv, resolvePlanCapCents } from '../../lib/billing-defaults'

describe('parsePositiveIntEnv', () => {
	it('parses a valid positive integer string', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '2000' })).toBe(2000)
	})

	it('returns null when unset or blank', () => {
		expect(parsePositiveIntEnv('CAP', {})).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '' })).toBeNull()
	})

	it('rejects non-digit shapes (scientific notation, decimals, underscores)', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '1e9' })).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '1.5' })).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '2_000' })).toBeNull()
	})

	it('rejects zero and negative values', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '0' })).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '-5' })).toBeNull()
	})

	it('clamps pathologically long digit strings to MAX_ENV_CAP', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '9'.repeat(30) })).toBe(MAX_ENV_CAP)
	})
})

describe('resolvePlanCapCents', () => {
	it('returns the kroner-derived caps for every paid plan even when their env vars hold other values', () => {
		// Regression: prod's MASKIN_PRO_HARD_CAP_USD_CENTS pinned Pro at $20.
		const env = {
			MASKIN_STARTER_HARD_CAP_USD_CENTS: '2000',
			MASKIN_PRO_HARD_CAP_USD_CENTS: '2000',
			MASKIN_TEAM_HARD_CAP_USD_CENTS: '2000',
			MASKIN_ULTRA_HARD_CAP_USD_CENTS: '2000',
		}
		// 20, 50, 110 and 300 kroner at the fixed 7.0 kroner per dollar, in USD cents.
		expect(resolvePlanCapCents('starter', env)).toBe(286)
		expect(resolvePlanCapCents('pro', env)).toBe(714)
		expect(resolvePlanCapCents('team', env)).toBe(1_571)
		expect(resolvePlanCapCents('ultra', env)).toBe(4_286)
	})

	it('derives each cap from the included kroner and the one rate', () => {
		for (const plan of ['starter', 'pro', 'team', 'ultra'] as const) {
			expect(resolvePlanCapCents(plan, {})).toBe(dkkToUsdCents(INCLUDED_USAGE_DKK[plan]))
		}
	})

	it('still lets env override the trial cap', () => {
		expect(resolvePlanCapCents('trial', { MASKIN_TRIAL_HARD_CAP_USD_CENTS: '50' })).toBe(50)
		expect(resolvePlanCapCents('trial', {})).toBe(286)
	})
})
