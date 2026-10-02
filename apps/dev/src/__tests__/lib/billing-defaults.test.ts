import { describe, expect, it } from 'vitest'
import {
	MAX_ENV_CAP,
	PRO_HARD_CAP_DEFAULT_USD_CENTS,
	TEAM_HARD_CAP_DEFAULT_USD_CENTS,
	TRIAL_HARD_CAP_DEFAULT_USD_CENTS,
	parsePositiveIntEnv,
	resolvePlanCapCents,
} from '../../lib/billing-defaults'

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
	it('returns the code cap for Pro and Team even when the env holds another value', () => {
		// Prod's Pro env was stuck at 2000 ($20) while Pro is a $49 plan.
		const env = {
			MASKIN_PRO_HARD_CAP_USD_CENTS: '2000',
			MASKIN_TEAM_HARD_CAP_USD_CENTS: '1',
		}
		expect(resolvePlanCapCents('pro', env)).toBe(4_900)
		expect(resolvePlanCapCents('pro', env)).toBe(PRO_HARD_CAP_DEFAULT_USD_CENTS)
		expect(resolvePlanCapCents('team', env)).toBe(TEAM_HARD_CAP_DEFAULT_USD_CENTS)
	})

	it('still honours MASKIN_TRIAL_HARD_CAP_USD_CENTS for the trial', () => {
		expect(resolvePlanCapCents('trial', { MASKIN_TRIAL_HARD_CAP_USD_CENTS: '3000' })).toBe(3_000)
		expect(resolvePlanCapCents('trial', {})).toBe(TRIAL_HARD_CAP_DEFAULT_USD_CENTS)
	})
})
