/**
 * daily-budget-card.ts — the text of the morning budget card (daily token budget, slice 1a).
 *
 * Pure: facts in, words out, so the numbers on the card can be tested without a database. The
 * scheduler reads the facts (`services/daily-budget-card-scheduler.ts`); nothing here is stored.
 *
 * Cost is "unknown", never zero: a session whose cost the platform did not record is counted
 * apart from the ones that have a number, and a trigger with no known cost reads "Estimate
 * unknown" instead of $0.
 */

import { type DailyBudget, dailyBudgetSchema } from '@maskin/shared'

export type BudgetUnit = DailyBudget['unit']

export interface BudgetTarget {
	unit: BudgetUnit
	/** Per day, in `unit`. */
	amount: number
}

/** What the sessions of one trigger did over a window. `null` triggerId = not started by one. */
export interface TriggerWindowStats {
	triggerId: string | null
	name: string
	runs: number
	/** Runs that carry a cost number in the target's unit. */
	knownRuns: number
	/** Sum of the cost of the known runs, in the target's unit. */
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

export function formatAmount(value: number, unit: BudgetUnit): string {
	if (unit === 'dollars') return `$${value.toFixed(2)}`
	const abs = Math.abs(value)
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`
	if (abs >= 1_000) return `${Math.round(value / 1_000)}k tokens`
	return `${Math.round(value)} tokens`
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
}

export interface BudgetCardText {
	headline: string
	rationale: string
}

/** Yesterday's line: what ran and what it cost, with unknown cost said out loud. */
export function yesterdayLine(day: DayTotals, unit: BudgetUnit): string {
	if (day.runs === 0) return 'Yesterday: nothing ran.'
	const ran = plural(day.runs, 'run', 'runs')
	if (day.knownRuns === 0) return `Yesterday: ${ran}. Estimate unknown.`
	const cost = formatAmount(day.spent, unit)
	const missing = day.runs - day.knownRuns
	return missing > 0
		? `Yesterday: ${ran}, ${cost} (cost unknown for ${missing}).`
		: `Yesterday: ${ran}, ${cost}.`
}

export function todayLine(day: DayTotals, target: BudgetTarget): string {
	const goal = formatAmount(target.amount, target.unit)
	const so = formatAmount(day.spent, target.unit)
	return `Today: ${bar(day.spent / target.amount)} ${so} of ${goal} so far.`
}

export function forecastLines(
	f: MonthForecast,
	target: BudgetTarget,
	approximate: boolean,
): string[] {
	const label = approximate ? 'Month forecast (approximate)' : 'Month forecast'
	if (f.monthly === 0 && f.unknownTriggers > 0) {
		return [`${label}: Estimate unknown, no trigger has a recorded cost yet.`]
	}
	const percent = Math.round(f.share * 100)
	const lines = [
		`${label}: ${formatAmount(f.monthly, target.unit)} of ${formatAmount(f.monthTarget, target.unit)} (${percent}%).`,
	]
	if (f.warn) {
		lines.push(
			f.share >= 1
				? 'Over the month target at this pace.'
				: 'At 80% or more of the month target at this pace.',
		)
	}
	const named = f.heaviest.map(
		(p) =>
			`- ${p.name}: ${p.monthly === null ? 'Estimate unknown' : formatAmount(p.monthly, target.unit)}`,
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
	const { target, yesterday, today, forecast, approximate } = input
	return {
		headline: yesterdayLine(yesterday, target.unit),
		rationale: [todayLine(today, target), ...forecastLines(forecast, target, approximate)].join(
			'\n\n',
		),
	}
}

/**
 * The target as the target-setting task stores it on the workspace: `settings.daily_budget`
 * (`dailyBudgetSchema` in @maskin/shared: unit, amount, stop_share, timezone). The timezone is
 * an IANA name and lives with the target; there is no general workspace timezone. This is the
 * one place that reads that shape. Off (null) when the key is absent or does not parse, so a
 * workspace with no target gets no card.
 */
export function readBudgetSettings(
	settings: unknown,
): { target: BudgetTarget; timezone: string } | null {
	const parsed = dailyBudgetSchema.safeParse(
		(settings as { daily_budget?: unknown } | null)?.daily_budget,
	)
	if (!parsed.success) return null
	const { unit, amount, timezone } = parsed.data
	return { target: { unit, amount }, timezone }
}
