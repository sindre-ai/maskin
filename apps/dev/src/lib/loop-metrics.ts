import type { Database } from '@maskin/db'
import { objects, relationships } from '@maskin/db/schema'
import type { LoopTargetView } from '@maskin/shared'
import { type SQL, and, eq, inArray, sql } from 'drizzle-orm'
import { logger } from './logger'

/** Call days (today, this week, last 30 days) start at midnight in this zone. */
const CALL_DAY_TIME_ZONE = 'Europe/Copenhagen'

/** Same membership edge the flows list counts: source is the flow, target the member. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

type DayBounds = { today: string; weekStart: string; thirtyDaysStart: string }

/** Calendar dates (YYYY-MM-DD) in Copenhagen: today, this week's Monday, and
 * the first day of the 30 calendar days that end today. */
export function callDayBounds(now: Date): DayBounds {
	const today = new Intl.DateTimeFormat('en-CA', {
		timeZone: CALL_DAY_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(now)
	const todayUtc = new Date(`${today}T00:00:00Z`)
	const shiftDays = (days: number) =>
		new Date(todayUtc.getTime() + days * 86_400_000).toISOString().slice(0, 10)
	const sinceMonday = (todayUtc.getUTCDay() + 6) % 7
	return { today, weekStart: shiftDays(-sinceMonday), thirtyDaysStart: shiftDays(-29) }
}

/**
 * The fixed list of named metrics a flow target can read live, as
 * `metric:phone_sales.<key>`. Each counts the people (contact objects) linked to
 * the flow with the in_loop edge, from flags the sales agents keep on them.
 *
 * - call_done is a true/false flag and call_at the Copenhagen date of the call
 *   (YYYY-MM-DD, or a longer ISO string whose first ten characters are that date).
 * - calls_total and the call-day metrics are a floor: call_done is one flag per
 *   person, so a redial or a callback counts once. They stay a floor until a call
 *   log is the source.
 */
const callDone = sql`${objects.metadata}->>'call_done' = 'true'`
const callAt = sql`coalesce(${objects.metadata}->>'call_at', '')`

const PHONE_SALES_METRICS: Record<string, (days: DayBounds) => SQL> = {
	calls_total: () => sql`count(*) FILTER (WHERE ${callDone})`,
	calls_today: (d) => sql`count(*) FILTER (WHERE ${callDone} AND left(${callAt}, 10) = ${d.today})`,
	calls_this_week: (d) =>
		sql`count(*) FILTER (WHERE ${callDone} AND left(${callAt}, 10) >= ${d.weekStart})`,
	calls_last_30_days: (d) =>
		sql`count(*) FILTER (WHERE ${callDone} AND left(${callAt}, 10) >= ${d.thirtyDaysStart})`,
	call_ready: () =>
		sql`count(*) FILTER (WHERE ${objects.status} = 'qualified' AND ${objects.metadata}->>'next_channel' = 'call')`,
	meetings_booked: () =>
		sql`count(*) FILTER (WHERE ${objects.status} IN ('meeting_booked', 'converted'))`,
	interested: () =>
		sql`count(*) FILTER (WHERE ${objects.status} IN ('in_conversation', 'meeting_booked', 'converted'))`,
	owners_reached: () => sql`count(*) FILTER (WHERE ${objects.metadata}->>'owner_reached' = 'true')`,
}

const METRIC_SOURCE_RE = /^metric:phone_sales\.([a-z0-9_]+)$/

function metricKeyOf(source: string): string | null {
	const key = METRIC_SOURCE_RE.exec(source)?.[1]
	return key !== undefined && key in PHONE_SALES_METRICS ? key : null
}

type FlowWithTargets = { id: string; targets: LoopTargetView[] | null }

/**
 * Replaces `actual` with a live count on every target whose source is a known
 * `metric:phone_sales.<key>`, ignoring the stored number, and sets `manual` on every
 * row: false for those, true for the rest. Runs on the finished
 * targets of each flow, so it does not matter where the rows came from. Other
 * rows (plain-text sources, event: sources, unknown metric keys) keep the stored
 * number. One grouped query covers every flow in the response, and none runs when
 * no row asks for a metric. A failed query is logged and the stored numbers stay.
 */
export async function applyLiveTargets(
	db: Database,
	workspaceId: string,
	flows: FlowWithTargets[],
	now: Date = new Date(),
): Promise<void> {
	const wanted = new Map<string, Set<string>>()
	for (const flow of flows) {
		for (const row of flow.targets ?? []) {
			// Manual until a live count replaces the number below (also if that query fails).
			row.manual = true
			const key = metricKeyOf(row.source)
			if (key === null) continue
			wanted.set(flow.id, (wanted.get(flow.id) ?? new Set()).add(key))
		}
	}
	if (wanted.size === 0) return

	const days = callDayBounds(now)
	const keys = Array.from(new Set(Array.from(wanted.values()).flatMap((s) => Array.from(s))))
	const columns = keys.map(
		(key) =>
			sql`${(PHONE_SALES_METRICS[key] as (d: DayBounds) => SQL)(days)} AS ${sql.identifier(key)}`,
	)

	let rows: Array<Record<string, unknown>>
	try {
		rows = await db.execute<Record<string, unknown>>(sql`
			SELECT ${relationships.sourceId} AS loop_id, ${sql.join(columns, sql`, `)}
			FROM ${relationships}
			JOIN ${objects} ON ${objects.id} = ${relationships.targetId}
			WHERE ${and(
				eq(relationships.type, LOOP_MEMBERSHIP_RELATIONSHIP_TYPE),
				inArray(relationships.sourceId, Array.from(wanted.keys())),
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'contact'),
			)}
			GROUP BY ${relationships.sourceId}
		`)
	} catch (err) {
		logger.warn('Live flow target counts failed; showing stored numbers', {
			workspaceId,
			error: String(err),
		})
		return
	}

	const countsByLoop = new Map(rows.map((r) => [String(r.loop_id), r]))
	for (const flow of flows) {
		const counts = countsByLoop.get(flow.id)
		for (const row of flow.targets ?? []) {
			const key = metricKeyOf(row.source)
			if (key === null) continue
			// A flow with no people linked yet has no group row: its live count is 0.
			row.actual = Number(counts?.[key] ?? 0)
			row.manual = false
		}
	}
}
