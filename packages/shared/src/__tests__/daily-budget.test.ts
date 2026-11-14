import { describe, expect, it } from 'vitest'
import {
	DEFAULT_DAILY_BUDGET_PERCENT,
	dailyBudgetSchema,
	setDailyBudgetSchema,
	storedDailyBudgetSchema,
	toPercentBudget,
	workspaceSettingsSchema,
} from '../schemas'

describe('dailyBudgetSchema', () => {
	it('defaults the stop-at share to 100 and the timezone to UTC', () => {
		const parsed = dailyBudgetSchema.parse({ unit: 'percent', amount: 5 })
		expect(parsed).toEqual({ unit: 'percent', amount: 5, stop_share: 100, timezone: 'UTC' })
	})

	it.each([80, 90, 100])('accepts a stop-at share of %i', (stop_share) => {
		expect(dailyBudgetSchema.safeParse({ unit: 'percent', amount: 1, stop_share }).success).toBe(
			true,
		)
	})

	it.each([0.1, 3.3, 100])('accepts a percent target of %s', (amount) => {
		expect(dailyBudgetSchema.safeParse({ unit: 'percent', amount }).success).toBe(true)
	})

	it.each([
		['zero', { unit: 'percent', amount: 0 }],
		['negative', { unit: 'percent', amount: -5 }],
		['over 100', { unit: 'percent', amount: 100.1 }],
		['two decimals', { unit: 'percent', amount: 3.33 }],
		['tokens', { unit: 'tokens', amount: 1000 }],
		['dollars', { unit: 'dollars', amount: 10 }],
		['unknown unit', { unit: 'kroner', amount: 10 }],
		['share of 70', { unit: 'percent', amount: 10, stop_share: 70 }],
		['bad timezone', { unit: 'percent', amount: 10, timezone: 'Mars/Base' }],
	])('rejects %s', (_label, value) => {
		expect(dailyBudgetSchema.safeParse(value).success).toBe(false)
	})
})

describe('setDailyBudgetSchema', () => {
	it('takes null to switch the budget off', () => {
		expect(setDailyBudgetSchema.parse({ daily_budget: null })).toEqual({ daily_budget: null })
	})

	it('no longer takes a token or dollar target', () => {
		expect(
			setDailyBudgetSchema.safeParse({ daily_budget: { unit: 'tokens', amount: 1000 } }).success,
		).toBe(false)
	})
})

describe('storedDailyBudgetSchema', () => {
	it('still reads a target saved in tokens or dollars', () => {
		expect(storedDailyBudgetSchema.safeParse({ unit: 'tokens', amount: 2_000_000 }).success).toBe(
			true,
		)
		expect(storedDailyBudgetSchema.safeParse({ unit: 'dollars', amount: 12.34 }).success).toBe(true)
	})
})

describe('toPercentBudget', () => {
	const base = { stop_share: 90, timezone: 'Europe/Oslo' } as const

	it('returns a percent target unchanged', () => {
		const stored = { unit: 'percent', amount: 4, ...base } as const
		expect(toPercentBudget(stored, 2000)).toEqual({ budget: stored, earlier: null })
	})

	it('turns dollars a day into a share of the plan limit', () => {
		// $0.50 of a $20 plan (2000 cents) is 2.5%.
		const { budget, earlier } = toPercentBudget({ unit: 'dollars', amount: 0.5, ...base }, 2000)
		expect(budget).toEqual({ unit: 'percent', amount: 2.5, ...base })
		expect(earlier).toEqual({ unit: 'dollars', converted: true })
	})

	it('keeps a converted dollar target within 0.1 and 100', () => {
		expect(toPercentBudget({ unit: 'dollars', amount: 0.001, ...base }, 2000).budget.amount).toBe(
			0.1,
		)
		expect(toPercentBudget({ unit: 'dollars', amount: 500, ...base }, 2000).budget.amount).toBe(100)
	})

	it('uses the default for tokens, which have no fixed price', () => {
		const { budget, earlier } = toPercentBudget(
			{ unit: 'tokens', amount: 2_000_000, ...base },
			2000,
		)
		expect(budget.amount).toBe(DEFAULT_DAILY_BUDGET_PERCENT)
		expect(earlier).toEqual({ unit: 'tokens', converted: false })
	})

	it('uses the default for dollars when the plan limit is unknown', () => {
		const { budget, earlier } = toPercentBudget({ unit: 'dollars', amount: 5, ...base }, null)
		expect(budget.amount).toBe(DEFAULT_DAILY_BUDGET_PERCENT)
		expect(earlier).toEqual({ unit: 'dollars', converted: false })
	})
})

describe('workspaceSettingsSchema.daily_budget', () => {
	it('is off (absent) by default', () => {
		expect(workspaceSettingsSchema.parse({}).daily_budget).toBeUndefined()
	})

	it('keeps a target saved in tokens, so the workspace settings still parse', () => {
		const parsed = workspaceSettingsSchema.parse({ daily_budget: { unit: 'tokens', amount: 5000 } })
		expect(parsed.daily_budget).toMatchObject({ unit: 'tokens', amount: 5000 })
	})
})
