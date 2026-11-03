import { describe, expect, it } from 'vitest'
import {
	computeEffectiveTier,
	ownershipCapForTier,
	resolvePlanTier,
	seatCapForPlan,
} from '../../lib/workspace-capacity'

describe('seatCapForPlan / ownershipCapForTier', () => {
	// Literal cap table assertions — mirrors the verify-billing-cap-literals.mjs
	// pinning pattern already used for token caps, so a future bump to these
	// numbers is a deliberate, visible change rather than a silent drift.
	it.each([
		['trial', 1],
		['pro', 5],
		['team', 25],
		['enterprise', null],
	] as const)('seatCapForPlan(%s) === %s', (plan, expected) => {
		expect(seatCapForPlan(plan)).toBe(expected)
	})

	it.each([
		['trial', 1],
		['pro', 5],
		['team', 25],
		['enterprise', null],
	] as const)('ownershipCapForTier(%s) === %s', (tier, expected) => {
		expect(ownershipCapForTier(tier)).toBe(expected)
	})
})

describe('resolvePlanTier', () => {
	it('defaults to trial when settings has no billing key', () => {
		expect(resolvePlanTier({})).toBe('trial')
		expect(resolvePlanTier(null)).toBe('trial')
		expect(resolvePlanTier(undefined)).toBe('trial')
	})

	it('reads the plan from settings.billing.plan', () => {
		expect(resolvePlanTier({ billing: { plan: 'pro' } })).toBe('pro')
		expect(resolvePlanTier({ billing: { plan: 'team' } })).toBe('team')
		expect(resolvePlanTier({ billing: { plan: 'enterprise' } })).toBe('enterprise')
	})

	it('falls back to trial on malformed settings', () => {
		expect(resolvePlanTier({ billing: { plan: 'not-a-real-plan' } })).toBe('trial')
		expect(resolvePlanTier('not an object')).toBe('trial')
	})
})

describe('computeEffectiveTier', () => {
	it('returns the candidate plan when the actor owns nothing yet', () => {
		expect(computeEffectiveTier([], 'trial')).toBe('trial')
		expect(computeEffectiveTier([], 'pro')).toBe('pro')
	})

	it('returns the MAX tier across owned workspaces, not the candidate alone', () => {
		expect(computeEffectiveTier(['trial'], 'trial')).toBe('trial')
		expect(computeEffectiveTier(['pro'], 'trial')).toBe('pro')
		expect(computeEffectiveTier(['team', 'pro', 'pro'], 'trial')).toBe('team')
	})

	it('governs total owned-workspace count via a single MAX tier, not per-tier buckets', () => {
		// An actor owning 1 team + 24 pro workspaces (25 total) is at the team
		// cap (25) regardless of what tier a NEW claim would be at — a trial
		// candidate does not get its own separate 1-workspace allowance.
		const owned = ['team', ...Array(24).fill('pro')] as const
		const tier = computeEffectiveTier([...owned], 'trial')
		expect(tier).toBe('team')
		expect(ownershipCapForTier(tier)).toBe(25)
	})

	it('enterprise anywhere in the owned set dominates (unlimited effective tier)', () => {
		expect(computeEffectiveTier(['enterprise', 'trial'], 'trial')).toBe('enterprise')
		expect(ownershipCapForTier('enterprise')).toBeNull()
	})
})
