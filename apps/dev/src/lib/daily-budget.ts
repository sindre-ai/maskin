import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import {
	DAILY_BUDGET_ZERO_COST_LIMIT,
	DAILY_BUDGET_ZERO_COST_WINDOW_DAYS,
	type DailyBudgetResponse,
} from '@maskin/shared'
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm'

type ZeroCostDay = DailyBudgetResponse['dollar_unit']['days'][number]

export const DOLLAR_UNIT_LOCKED_REASON =
	'Dollars are off for now. The cost numbers are not reliable yet, so a dollar target would be wrong. Tokens work today.'

/**
 * Per local day over the last DAILY_BUDGET_ZERO_COST_WINDOW_DAYS days (today
 * included), how many sessions ended and how many of those carried no cost.
 * Local means `timezone`, midnight to midnight.
 *
 * This is the same population as the `$ai_generation` events the bet measures:
 * trackSessionAiGeneration fires once per session that reached a terminal
 * state with a started_at, and sends a missing cost as 0.
 */
export async function readZeroCostDays(
	db: Pick<Database, 'select'>,
	workspaceId: string,
	timezone: string,
	now: Date = new Date(),
): Promise<ZeroCostDay[]> {
	const localDay = sql<string>`to_char(${sessions.completedAt} AT TIME ZONE ${timezone}, 'YYYY-MM-DD')`
	const windowStart = sql`(date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE ${timezone}) - make_interval(days => ${DAILY_BUDGET_ZERO_COST_WINDOW_DAYS - 1})) AT TIME ZONE ${timezone}`
	const rows = await db
		.select({
			date: localDay,
			endedSessions: sql<number>`count(*)::int`,
			zeroCostSessions: sql<number>`(count(*) filter (where coalesce(${sessions.totalCostUsd}, 0) = 0))::int`,
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.workspaceId, workspaceId),
				isNotNull(sessions.startedAt),
				isNotNull(sessions.completedAt),
				gte(sessions.completedAt, sql`${windowStart}`),
			),
		)
		// By position: each ${timezone} is its own bind parameter, so Postgres cannot
		// tell the grouped expression from the selected one by text.
		.groupBy(sql`1`)
		.orderBy(sql`1`)
	return rows.map((r) => ({
		date: r.date,
		ended_sessions: r.endedSessions,
		zero_cost_sessions: r.zeroCostSessions,
	}))
}

/**
 * The dollar unit stays locked while any day in the window has 5% or more
 * zero-cost sessions. A day with no sessions says nothing either way, and a
 * workspace with no sessions at all has no cost data that could be wrong.
 */
export function evaluateDollarUnit(days: ZeroCostDay[]): DailyBudgetResponse['dollar_unit'] {
	const bad = days.some(
		(d) =>
			d.ended_sessions > 0 &&
			d.zero_cost_sessions / d.ended_sessions >= DAILY_BUDGET_ZERO_COST_LIMIT,
	)
	return { available: !bad, reason: bad ? DOLLAR_UNIT_LOCKED_REASON : null, days }
}
