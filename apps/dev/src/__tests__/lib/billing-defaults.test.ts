import { describe, expect, it } from 'vitest'
import {
	MAX_ENV_CAP,
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
	it('returns the code cap for pro even when the env still holds 2000', () => {
		expect(resolvePlanCapCents('pro', { MASKIN_PRO_HARD_CAP_USD_CENTS: '2000' })).toBe(4_900)
	})

	it('returns the code cap for team regardless of env', () => {
		expect(resolvePlanCapCents('team', { MASKIN_TEAM_HARD_CAP_USD_CENTS: '1000' })).toBe(20_000)
	})

	it('still reads the trial cap from env, then falls back to the literal', () => {
		expect(resolvePlanCapCents('trial', { MASKIN_TRIAL_HARD_CAP_USD_CENTS: '500' })).toBe(500)
		expect(resolvePlanCapCents('trial', {})).toBe(TRIAL_HARD_CAP_DEFAULT_USD_CENTS)
	})
})
