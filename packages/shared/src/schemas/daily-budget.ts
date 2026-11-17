import { z } from 'zod'
import { timezoneSchema } from './notification-preferences'

/**
 * The daily target is a percent of the plan's monthly allowance spent per day. Users see percent
 * of plan only; tokens and dollars are no longer a choice. `LEGACY_DAILY_BUDGET_UNITS` are the
 * units targets were stored in before that: they still parse so an old target does not vanish,
 * and `toPercentBudget` turns them into a percent on read.
 */
export const DAILY_BUDGET_UNITS = ['percent'] as const
export const LEGACY_DAILY_BUDGET_UNITS = ['tokens', 'dollars'] as const
export const DAILY_BUDGET_STOP_SHARES = [80, 90, 100] as const
export const DEFAULT_DAILY_BUDGET_STOP_SHARE = 100
/** Largest accepted percent target: the whole month's allowance in one day. */
export const DAILY_BUDGET_MAX_PERCENT = 100
/**
 * Used when an old token target cannot be turned into a percent: an even spread of a 30-day month
 * (100 / 30, rounded down to one decimal).
 */
export const DEFAULT_DAILY_BUDGET_PERCENT = 3.3
/** Largest stored legacy amount; keeps `amount` exact in a JS number and in the settings JSON. */
const LEGACY_MAX_AMOUNT = 1_000_000_000_000

export const dailyBudgetUnitSchema = z.enum(DAILY_BUDGET_UNITS)
export const legacyDailyBudgetUnitSchema = z.enum(LEGACY_DAILY_BUDGET_UNITS)

const stopShareSchema = z
	.union([z.literal(80), z.literal(90), z.literal(100)])
	.default(DEFAULT_DAILY_BUDGET_STOP_SHARE)

/**
 * One daily target per workspace. Stored under `settings.daily_budget`; absent
 * means off. Shaped so it maps onto the Admission `budgets` row later
 * (scope_kind workspace, period day): `amount` is the cap in percent of the plan allowance, and
 * `stop_share` is the share of the cap at which new work stops being admitted.
 * `timezone` fixes what "a day" means (midnight to midnight there).
 * Nothing reads `stop_share` yet: the target only reports in 1a.
 */
export const dailyBudgetSchema = z
	.object({
		unit: dailyBudgetUnitSchema,
		amount: z.number().positive().max(DAILY_BUDGET_MAX_PERCENT),
		stop_share: stopShareSchema,
		timezone: timezoneSchema.default('UTC'),
	})
	.superRefine((v, ctx) => {
		if (Math.abs(v.amount * 10 - Math.round(v.amount * 10)) > 1e-6) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['amount'],
				message: 'A percent target can have at most one decimal',
			})
		}
	})

export type DailyBudget = z.infer<typeof dailyBudgetSchema>

/** A target saved before percent: tokens or dollars per day. Read only, never written. */
const legacyDailyBudgetSchema = z.object({
	unit: legacyDailyBudgetUnitSchema,
	amount: z.number().positive().max(LEGACY_MAX_AMOUNT),
	stop_share: stopShareSchema,
	timezone: timezoneSchema.default('UTC'),
})

/** What `settings.daily_budget` may hold: a percent target, or an older token or dollar one. */
export const storedDailyBudgetSchema = z.union([dailyBudgetSchema, legacyDailyBudgetSchema])

export type StoredDailyBudget = z.infer<typeof storedDailyBudgetSchema>

export interface EarlierDailyTarget {
	unit: (typeof LEGACY_DAILY_BUDGET_UNITS)[number]
	/** True when the old amount was turned into a percent, false when the default was used. */
	converted: boolean
}

const roundOneDecimal = (n: number) => Math.round(n * 10) / 10

/**
 * The target as a percent of the plan. A percent target is returned as is. A dollar target becomes
 * its share of the plan's limit (`capCents`), rounded to one decimal and kept within 0.1 to 100. A
 * token target cannot be turned into a percent (tokens have no fixed price), and a dollar target
 * cannot either when the plan limit is unknown, so both fall back to the default percent. Nothing
 * is written: the stored value is left as it is until the owner saves a new target.
 */
export function toPercentBudget(
	stored: StoredDailyBudget,
	capCents: number | null,
): { budget: DailyBudget; earlier: EarlierDailyTarget | null } {
	if (stored.unit === 'percent') return { budget: stored, earlier: null }
	const { unit, ...rest } = stored
	const canConvert = unit === 'dollars' && capCents !== null && capCents > 0
	const amount = canConvert
		? Math.min(
				DAILY_BUDGET_MAX_PERCENT,
				Math.max(0.1, roundOneDecimal(((stored.amount * 100) / capCents) * 100)),
			)
		: DEFAULT_DAILY_BUDGET_PERCENT
	return {
		budget: { ...rest, unit: 'percent', amount },
		earlier: { unit, converted: canConvert },
	}
}

/** PUT body: a target to store, or null to switch the daily budget off. */
export const setDailyBudgetSchema = z.object({
	daily_budget: dailyBudgetSchema.nullable(),
})

export const dailyBudgetResponseSchema = z.object({
	/** Always in percent of the plan. An older token or dollar target is converted on read. */
	daily_budget: dailyBudgetSchema.nullable(),
	/** Set when `daily_budget` was made from an older token or dollar target. */
	earlier_target: z
		.object({
			unit: legacyDailyBudgetUnitSchema,
			converted: z.boolean(),
		})
		.nullable(),
	/** False when the plan has no limit to take a percent of (an unmetered plan). */
	plan_limit_known: z.boolean(),
})

export type DailyBudgetResponse = z.infer<typeof dailyBudgetResponseSchema>
