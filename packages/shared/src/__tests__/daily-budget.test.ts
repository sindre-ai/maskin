import { describe, expect, it } from 'vitest'
import { dailyBudgetSchema, setDailyBudgetSchema, workspaceSettingsSchema } from '../schemas'

describe('dailyBudgetSchema', () => {
	it('defaults the stop-at share to 100 and the timezone to UTC', () => {
		const parsed = dailyBudgetSchema.parse({ unit: 'tokens', amount: 2000000 })
		expect(parsed).toEqual({ unit: 'tokens', amount: 2000000, stop_share: 100, timezone: 'UTC' })
	})

	it.each([80, 90, 100])('accepts a stop-at share of %i', (stop_share) => {
		expect(dailyBudgetSchema.safeParse({ unit: 'tokens', amount: 1, stop_share }).success).toBe(
			true,
		)
	})

	it.each([
		['zero', { unit: 'tokens', amount: 0 }],
		['negative', { unit: 'dollars', amount: -5 }],
		['fractional tokens', { unit: 'tokens', amount: 1.5 }],
		['three-decimal dollars', { unit: 'dollars', amount: 10.005 }],
		['unknown unit', { unit: 'kroner', amount: 10 }],
		['share of 70', { unit: 'tokens', amount: 10, stop_share: 70 }],
		['bad timezone', { unit: 'tokens', amount: 10, timezone: 'Mars/Base' }],
	])('rejects %s', (_label, value) => {
		expect(dailyBudgetSchema.safeParse(value).success).toBe(false)
	})

	it('accepts a dollar target with cents', () => {
		expect(dailyBudgetSchema.safeParse({ unit: 'dollars', amount: 12.34 }).success).toBe(true)
	})
})

describe('setDailyBudgetSchema', () => {
	it('takes null to switch the budget off', () => {
		expect(setDailyBudgetSchema.parse({ daily_budget: null })).toEqual({ daily_budget: null })
	})
})

describe('workspaceSettingsSchema.daily_budget', () => {
	it('is off (absent) by default', () => {
		expect(workspaceSettingsSchema.parse({}).daily_budget).toBeUndefined()
	})
})
