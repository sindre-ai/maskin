import { z } from 'zod'
import { timezoneSchema } from './notification-preferences'

export const DAILY_BUDGET_UNITS = ['tokens', 'dollars'] as const
export const DAILY_BUDGET_STOP_SHARES = [80, 90, 100] as const
export const DEFAULT_DAILY_BUDGET_STOP_SHARE = 100
/** Largest accepted target; keeps `amount` exact in a JS number and in the settings JSON. */
export const DAILY_BUDGET_MAX_AMOUNT = 1_000_000_000_000
/** Zero-cost share (of ended sessions in a day) at which the dollar unit is locked. */
export const DAILY_BUDGET_ZERO_COST_LIMIT = 0.05
export const DAILY_BUDGET_ZERO_COST_WINDOW_DAYS = 7

export const dailyBudgetUnitSchema = z.enum(DAILY_BUDGET_UNITS)

/**
 * One daily target per workspace. Stored under `settings.daily_budget`; absent
 * means off. Shaped so it maps onto the Admission `budgets` row later
 * (scope_kind workspace, period day): `unit` becomes that table's unit column,
 * `amount` is its cap (tokens, or dollars when `unit` is dollars), and
 * `stop_share` is the share of the cap at which new work stops being admitted.
 * `timezone` fixes what "a day" means (midnight to midnight there).
 * Nothing reads `stop_share` yet: the target only reports in 1a.
 */
export const dailyBudgetSchema = z
	.object({
		unit: dailyBudgetUnitSchema,
		amount: z.number().positive().max(DAILY_BUDGET_MAX_AMOUNT),
		stop_share: z
			.union([z.literal(80), z.literal(90), z.literal(100)])
			.default(DEFAULT_DAILY_BUDGET_STOP_SHARE),
		timezone: timezoneSchema.default('UTC'),
	})
	.superRefine((v, ctx) => {
		if (v.unit === 'tokens' && !Number.isInteger(v.amount)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['amount'],
				message: 'A token target must be a whole number',
			})
		}
		if (v.unit === 'dollars' && Math.abs(v.amount * 100 - Math.round(v.amount * 100)) > 1e-6) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['amount'],
				message: 'A dollar target can have at most two decimals',
			})
		}
	})

export type DailyBudget = z.infer<typeof dailyBudgetSchema>

/** PUT body: a target to store, or null to switch the daily budget off. */
export const setDailyBudgetSchema = z.object({
	daily_budget: dailyBudgetSchema.nullable(),
})

export const dailyBudgetZeroCostDaySchema = z.object({
	/** Local date (YYYY-MM-DD) in the budget timezone. */
	date: z.string(),
	ended_sessions: z.number().int().nonnegative(),
	zero_cost_sessions: z.number().int().nonnegative(),
})

export const dailyBudgetResponseSchema = z.object({
	daily_budget: dailyBudgetSchema.nullable(),
	/** Whether a dollar target can be switched on, and if not, why. */
	dollar_unit: z.object({
		available: z.boolean(),
		reason: z.string().nullable(),
		days: z.array(dailyBudgetZeroCostDaySchema),
	}),
})

export type DailyBudgetResponse = z.infer<typeof dailyBudgetResponseSchema>
