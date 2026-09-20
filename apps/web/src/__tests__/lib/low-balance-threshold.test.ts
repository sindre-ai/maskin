import {
	LOW_BALANCE_FLOOR_CENTS,
	computeLowBalanceThresholdCents,
	decideLowBalance,
} from '@/lib/low-balance-threshold'
import { describe, expect, it } from 'vitest'

describe('computeLowBalanceThresholdCents', () => {
	it('is the $2 floor for a workspace with no recent topups', () => {
		expect(computeLowBalanceThresholdCents(0)).toBe(LOW_BALANCE_FLOOR_CENTS)
	})

	it('is the $2 floor when 20% of recent burn is below it', () => {
		// $5 of topups → 20% = 100¢ → below the $2 floor
		expect(computeLowBalanceThresholdCents(500)).toBe(LOW_BALANCE_FLOOR_CENTS)
	})

	it('is 20% of recent burn once it clears the $2 floor', () => {
		// $100 of topups in 30d → 20% = $20 = 2000¢ → above the $2 floor
		expect(computeLowBalanceThresholdCents(10_000)).toBe(2_000)
	})

	it('floors the percent-based value so it stays an integer cents amount', () => {
		// 20% of 105¢ = 21¢ → still below floor, so we get the floor
		expect(computeLowBalanceThresholdCents(105)).toBe(LOW_BALANCE_FLOOR_CENTS)
	})
})

describe('decideLowBalance', () => {
	it('does not show when balance is zero — that is the zero-balance modal case, not a warning', () => {
		expect(decideLowBalance({ creditBalanceCents: 0, sumTopupsLast30dCents: 10_000 }).show).toBe(
			false,
		)
	})

	it('shows when balance is a positive amount under the floor', () => {
		const decision = decideLowBalance({
			creditBalanceCents: 185,
			sumTopupsLast30dCents: 0,
		})
		expect(decision.show).toBe(true)
		expect(decision.thresholdCents).toBe(LOW_BALANCE_FLOOR_CENTS)
	})

	it('shows when balance is under 20% of recent burn on a high-burn workspace', () => {
		// $100 topups → threshold $20 → balance of $15 flips the banner on
		const decision = decideLowBalance({
			creditBalanceCents: 1_500,
			sumTopupsLast30dCents: 10_000,
		})
		expect(decision.show).toBe(true)
		expect(decision.thresholdCents).toBe(2_000)
	})

	it('does not show when balance exceeds the threshold', () => {
		const decision = decideLowBalance({
			creditBalanceCents: 5_000,
			sumTopupsLast30dCents: 10_000,
		})
		expect(decision.show).toBe(false)
	})

	it('shows exactly at the threshold — the rule is <=, not <', () => {
		const decision = decideLowBalance({
			creditBalanceCents: LOW_BALANCE_FLOOR_CENTS,
			sumTopupsLast30dCents: 0,
		})
		expect(decision.show).toBe(true)
	})
})
