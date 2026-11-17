/**
 * daily-budget-hold.ts — what the workspace's daily target means for new work (daily budget 1b,
 * task "Park work at the daily limit, run it later").
 *
 * Two readings, both from the number the morning card shows (`readWindowStats` in
 * daily-budget-card-scheduler.ts), so there is no second today-against-target figure:
 *   - `readDayAgainstTarget`: today's spend and the stop-at line for one workspace.
 *   - `heldUntil`: when held work is let go if nothing else lets it go first.
 *
 * Held work is a session row parked in `starting` / `waiting_for_machine` with `config.held` set
 * and a dispatch-queue row that is not due yet (`SessionManager.holdSession`). The release pass in
 * held-session-release.ts lets it go, most important first.
 */
import type { Database } from '@maskin/db'
import { sessions, workspaces } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { resolveWorkspaceCapCents } from '../lib/daily-budget'
import { readBudgetSettings } from '../lib/daily-budget-card'
import { readWindowStats, startOfLocalDay, totalsOf } from './daily-budget-card-scheduler'

/** Set to 0 to stop holding work at the daily limit; everything starts at once, as before. */
export const DAILY_BUDGET_HOLD_KILLSWITCH_ENV_VAR = 'FEATURE_DAILY_BUDGET_HOLD'
/**
 * The release pass lets held work go as soon as there is room. This is the backstop: the queue row
 * of a held session comes due this long after the next local day starts, so work is never held
 * past the next day even if the release pass is not running. The wait gives the pass the first
 * go at the new day so it can start work most important first.
 */
export const HELD_BACKSTOP_AFTER_DAY_START_MS = 10 * 60_000

/** `config.held` on a session that is waiting for room under the daily target. */
export interface HeldConfig {
	importance: 'normal' | 'low'
	held_at: string
	/** When the queue row comes due on its own (the backstop). */
	until: string
	/** Set when the session is let go. */
	released_at?: string
}

export interface DayAgainstTarget {
	/** Today's spend, percent of the plan. */
	spent: number
	/** The daily target, percent of the plan. */
	target: number
	/** Percent of the target at which new work stops being admitted (80, 90 or 100). */
	stopShare: number
	timezone: string
	dayStart: Date
	/** The start of the next local day. */
	nextDayStart: Date
}

/** True once spend has reached the stop-at share of the target. */
export function stopLineReached(day: Pick<DayAgainstTarget, 'spent' | 'target' | 'stopShare'>) {
	return day.spent >= (day.target * day.stopShare) / 100
}

/**
 * The first instant of the local day after the one `at` falls in. The day is a fixed 24 hours in
 * the common case; a clock change is settled by asking for the day start again from just past it.
 */
export function nextLocalDayStart(at: Date, timezone: string): Date | null {
	const start = startOfLocalDay(at, timezone)
	if (!start) return null
	// 25 hours always lands inside the next local day, whichever way the clock moved.
	return startOfLocalDay(new Date(start.getTime() + 25 * 60 * 60_000), timezone)
}

/**
 * Today's spend against the target for one workspace, or null when there is nothing to hold work
 * against: no target set, an unmetered plan (no limit to take a percent of), or an unreadable
 * timezone.
 */
export async function readDayAgainstTarget(
	db: Database,
	workspaceId: string,
	now: Date,
): Promise<DayAgainstTarget | null> {
	const [ws] = await db
		.select({
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!ws || !(ws.settings as { daily_budget?: unknown } | null)?.daily_budget) return null
	const capCents = resolveWorkspaceCapCents(ws)
	if (capCents === null) return null
	const cfg = readBudgetSettings(ws.settings, capCents)
	if (!cfg) return null
	const dayStart = startOfLocalDay(now, cfg.timezone)
	const nextDayStart = dayStart && nextLocalDayStart(now, cfg.timezone)
	if (!dayStart || !nextDayStart) return null
	const today = totalsOf(await readWindowStats(db, workspaceId, capCents, dayStart, now))
	return {
		spent: today.spent,
		target: cfg.target.amount,
		stopShare: cfg.stopShare,
		timezone: cfg.timezone,
		dayStart,
		nextDayStart,
	}
}

/** Matches a session that is held and not yet let go. */
export const heldNotReleased = sql`(${sessions.config}->'held' is not null and ${sessions.config}->'held'->>'released_at' is null)`
