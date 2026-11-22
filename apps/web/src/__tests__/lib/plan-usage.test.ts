import {
	costPercentOfPlan,
	formatPlanPercent,
	periodEndLabel,
	planUsageState,
} from '@/lib/plan-usage'
import { describe, expect, it } from 'vitest'

const base = {
	plan: 'trial' as const,
	status: 'active' as const,
	usd_cents_used: 0,
	hard_cap_usd_cents: 286 as number | null,
	credit_balance_cents: 0,
}

describe('planUsageState', () => {
	it('is primary under 80%, warning from 80%, error at 100%', () => {
		expect(planUsageState({ ...base, usd_cents_used: 100 })).toMatchObject({
			percent: 34,
			tone: 'primary',
			warn: false,
			paused: false,
		})
		expect(planUsageState({ ...base, usd_cents_used: 229 })).toMatchObject({
			percent: 80,
			tone: 'warning',
			warn: true,
			paused: false,
		})
		expect(planUsageState({ ...base, usd_cents_used: 286 })).toMatchObject({
			percent: 100,
			tone: 'error',
			paused: true,
		})
	})

	it('divides by the stored cap the server stops on', () => {
		// 4,900 of 4,900 is the old Pro $49 plan: 100% there, not 100% of the new 50 kr cap.
		expect(
			planUsageState({ ...base, plan: 'pro', usd_cents_used: 4900, hard_cap_usd_cents: 4900 }),
		).toMatchObject({ percent: 100 })
	})

	it('is not paused while a credit balance keeps new work starting', () => {
		expect(
			planUsageState({ ...base, plan: 'pro', usd_cents_used: 300, credit_balance_cents: 2500 }),
		).toMatchObject({ percent: 100, paused: false })
		// A balance does not help a subscription that cannot be billed.
		expect(
			planUsageState({
				...base,
				plan: 'pro',
				status: 'past_due',
				usd_cents_used: 300,
				credit_balance_cents: 2500,
			}),
		).toMatchObject({ paused: true })
	})

	it('shows no figure for enterprise, unloaded usage or an unknown cap', () => {
		expect(planUsageState(undefined)).toBeNull()
		expect(planUsageState({ ...base, plan: 'enterprise' })).toBeNull()
		expect(planUsageState({ ...base, hard_cap_usd_cents: null })).toBeNull()
	})
})

describe('periodEndLabel', () => {
	it('names the day the period ends', () => {
		const now = new Date('2026-11-09T12:00:00Z').getTime()
		expect(periodEndLabel(7 * 86_400_000, now)).toBe('16 Nov')
	})

	it('is null when there is no future end', () => {
		expect(periodEndLabel(0)).toBeNull()
		expect(periodEndLabel(null)).toBeNull()
	})
})

describe('costPercentOfPlan and formatPlanPercent', () => {
	it('turns a dollar cost into a share of the cap', () => {
		expect(costPercentOfPlan(1.43, 286)).toBeCloseTo(50, 5)
		expect(formatPlanPercent(costPercentOfPlan(1.43, 286))).toBe('50%')
	})

	it('never shows real use as 0% and makes no figure up without a cap', () => {
		expect(formatPlanPercent(0.2)).toBe('<1%')
		expect(formatPlanPercent(0)).toBe('0%')
		expect(costPercentOfPlan(1, null)).toBeNull()
		expect(formatPlanPercent(null)).toBe('—')
	})
})
