/**
 * daily-budget-card.ts — the text of the morning budget card (daily budget, slice 1a).
 *
 * Pure: facts in, words out, so the numbers on the card can be tested without a database. The
 * scheduler reads the facts (`services/daily-budget-card-scheduler.ts`); nothing here is stored.
 *
 * Every amount is a percent of the plan's monthly allowance: no tokens and no dollars reach the
 * card. The scheduler turns each session's cost into that percent before it gets here.
 *
 * Cost is "unknown", never zero: a session whose cost the platform did not record is counted
 * apart from the ones that have a number, and a trigger with no known cost reads "Estimate
 * unknown" instead of 0%.
 */

import { storedDailyBudgetSchema, toPercentBudget } from '@maskin/shared'

export interface BudgetTarget {
	/** Percent of the plan's monthly allowance, per day. */
	amount: number
}

/** What the sessions of one trigger did over a window. `null` triggerId = not started by one. */
export interface TriggerWindowStats {
	triggerId: string | null
	name: string
	runs: number
	/** Runs that carry a cost number. */
	knownRuns: number
	/** Sum of the cost of the known runs, in percent of the plan. */
	spent: number
}

export interface DayTotals {
	runs: number
	knownRuns: number
	spent: number
}

export interface TriggerProjection {
	name: string
	/** Projected spend for the month, or null when no run of this trigger has a known cost. */
	monthly: number | null
}

export interface MonthForecast {
	/** Sum of the triggers whose cost is known. */
	monthly: number
	monthTarget: number
	/** monthly / monthTarget */
	share: number
	/** At or over 80% of the month target. */
	warn: boolean
	/** Highest projected spend first, at most five, unknown-cost triggers last. */
	heaviest: TriggerProjection[]
	/** Triggers that fire but have no known cost, so the total leaves them out. */
	unknownTriggers: number
}

export const WARN_SHARE = 0.8
export const HEAVIEST_COUNT = 5

/**
 * Recent average cost per run, times how often the trigger fires, projected over the month.
 * `lookbackDays` is the length of the window `stats` covers; `daysInMonth` the month being
 * projected. A trigger with no known-cost run has no projection (null), not zero.
 */
export function projectMonth(
	stats: TriggerWindowStats[],
	target: BudgetTarget,
	lookbackDays: number,
	daysInMonth: number,
): MonthForecast {
	const projections: TriggerProjection[] = stats.map((s) => {
		if (s.knownRuns === 0) return { name: s.name, monthly: null }
		const avgPerRun = s.spent / s.knownRuns
		const runsPerDay = s.runs / lookbackDays
		return { name: s.name, monthly: avgPerRun * runsPerDay * daysInMonth }
	})
	const monthly = projections.reduce((sum, p) => sum + (p.monthly ?? 0), 0)
	const monthTarget = target.amount * daysInMonth
	const heaviest = [...projections]
		.sort((a, b) => (b.monthly ?? -1) - (a.monthly ?? -1) || a.name.localeCompare(b.name))
		.slice(0, HEAVIEST_COUNT)
	return {
		monthly,
		monthTarget,
		share: monthTarget > 0 ? monthly / monthTarget : 0,
		warn: monthTarget > 0 && monthly >= WARN_SHARE * monthTarget,
		heaviest,
		unknownTriggers: projections.filter((p) => p.monthly === null).length,
	}
}

/** "3.3%", "12%", "<0.1%" for a small non-zero share so real use never reads as 0%. */
export function formatPercent(value: number): string {
	if (!(value > 0)) return '0%'
	if (value < 0.1) return '<0.1%'
	return `${Number((Math.round(value * 10) / 10).toFixed(1))}%`
}

/** Ten-cell bar; at least one cell shows once anything is spent, all ten stay full past 100%. */
export function bar(share: number): string {
	const cells = 10
	const filled = share <= 0 ? 0 : Math.min(cells, Math.max(1, Math.round(share * cells)))
	return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`
}

export interface BudgetCardInput {
	target: BudgetTarget
	yesterday: DayTotals
	today: DayTotals
	forecast: MonthForecast
	/** True while per-trigger totals from "Show what a session cost" have not shipped. */
	approximate: boolean
	/** A line about an older target that could not be converted, when there is one. */
	note?: string
}

export interface BudgetCardText {
	headline: string
	rationale: string
}

/** Yesterday's line: what ran and how much of the plan it used, with unknown cost said out loud. */
export function yesterdayLine(day: DayTotals): string {
	if (day.runs === 0) return 'Yesterday: nothing ran.'
	const ran = plural(day.runs, 'run', 'runs')
	if (day.knownRuns === 0) return `Yesterday: ${ran}. Estimate unknown.`
	const cost = `${formatPercent(day.spent)} of plan`
	const missing = day.runs - day.knownRuns
	return missing > 0
		? `Yesterday: ${ran}, ${cost} (cost unknown for ${missing}).`
		: `Yesterday: ${ran}, ${cost}.`
}

export function todayLine(day: DayTotals, target: BudgetTarget): string {
	return `Today: ${bar(day.spent / target.amount)} ${formatPercent(day.spent)} of ${formatPercent(target.amount)} so far.`
}

export function forecastLines(f: MonthForecast, approximate: boolean): string[] {
	const label = approximate ? 'Month forecast (approximate)' : 'Month forecast'
	if (f.monthly === 0 && f.unknownTriggers > 0) {
		return [`${label}: Estimate unknown, no trigger has a recorded cost yet.`]
	}
	const lines = [
		`${label}: ${formatPercent(f.monthly)} of plan. Your daily target adds up to ${formatPercent(f.monthTarget)} over the month.`,
	]
	if (f.warn) {
		lines.push(
			f.share >= 1
				? 'Over the month target at this pace.'
				: 'At 80% or more of the month target at this pace.',
		)
	}
	const named = f.heaviest.map(
		(p) => `- ${p.name}: ${p.monthly === null ? 'Estimate unknown' : formatPercent(p.monthly)}`,
	)
	if (named.length > 0) lines.push(`Heaviest triggers:\n${named.join('\n')}`)
	if (f.unknownTriggers > 0 && f.monthly > 0) {
		lines.push(
			`${plural(f.unknownTriggers, 'trigger has', 'triggers have')} no recorded cost, so ${f.unknownTriggers === 1 ? 'it is' : 'they are'} left out of the total.`,
		)
	}
	return lines
}

export function buildBudgetCard(input: BudgetCardInput): BudgetCardText {
	const { target, yesterday, today, forecast, approximate, note } = input
	return {
		headline: yesterdayLine(yesterday),
		rationale: [
			todayLine(today, target),
			...forecastLines(forecast, approximate),
			...(note ? [note] : []),
		].join('\n\n'),
	}
}

/**
 * The target as the target-setting task stores it on the workspace: `settings.daily_budget`
 * (`storedDailyBudgetSchema` in @maskin/shared: unit, amount, stop_share, timezone), turned into
 * percent of the plan. `capCents` is the plan limit; an older dollar target is converted with it,
 * and a token target (or an unknown limit) falls back to the default percent, which `note` says
 * on the card. The timezone is an IANA name and lives with the target; there is no general
 * workspace timezone. This is the one place that reads that shape. Off (null) when the key is
 * absent or does not parse, so a workspace with no target gets no card.
 */
export function readBudgetSettings(
	settings: unknown,
	capCents: number | null,
): { target: BudgetTarget; timezone: string; note: string | null } | null {
	const parsed = storedDailyBudgetSchema.safeParse(
		(settings as { daily_budget?: unknown } | null)?.daily_budget,
	)
	if (!parsed.success) return null
	const { budget, earlier } = toPercentBudget(parsed.data, capCents)
	return {
		target: { amount: budget.amount },
		timezone: budget.timezone,
		note:
			earlier && !earlier.converted
				? `Your earlier daily target could not be turned into a percent of your plan, so this card uses ${formatPercent(budget.amount)} a day. Set a percent in Settings, Billing.`
				: null,
	}
}
