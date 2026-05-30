import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'

// Throttle caps from A1's ADR (Option C): 3 successful drafts per cookie
// (hard cap, no reset) + 5/min · 30/day per IP. We count from the `objects`
// table (rows persisted with type='bet_draft' on the landing_guests
// workspace) — no separate audit log, because the ADR caps successful
// drafts, not request volume.

export const COOKIE_DRAFT_CAP = 3
export const PER_IP_PER_MINUTE_CAP = 5
export const PER_IP_PER_DAY_CAP = 30

export const BET_DRAFT_TYPE = 'bet_draft'

export type ThrottleVerdict =
	| { allowed: true }
	| { allowed: false; reason: 'cookie_quota' | 'ip_rate' | 'ip_daily' }

export async function checkGuestThrottle(
	db: Database,
	params: {
		workspaceId: string
		guestSessionId: string
		ip: string
		now?: Date
	},
): Promise<ThrottleVerdict> {
	const now = params.now ?? new Date()
	const oneMinuteAgo = new Date(now.getTime() - 60_000)
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60_000)

	const [cookieRow] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, params.workspaceId),
				eq(objects.type, BET_DRAFT_TYPE),
				sql`metadata->>'guestSessionId' = ${params.guestSessionId}`,
			),
		)

	if ((cookieRow?.count ?? 0) >= COOKIE_DRAFT_CAP) {
		return { allowed: false, reason: 'cookie_quota' }
	}

	const [minuteRow] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, params.workspaceId),
				eq(objects.type, BET_DRAFT_TYPE),
				sql`metadata->>'ip' = ${params.ip}`,
				gte(objects.createdAt, oneMinuteAgo),
			),
		)

	if ((minuteRow?.count ?? 0) >= PER_IP_PER_MINUTE_CAP) {
		return { allowed: false, reason: 'ip_rate' }
	}

	const [dayRow] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, params.workspaceId),
				eq(objects.type, BET_DRAFT_TYPE),
				sql`metadata->>'ip' = ${params.ip}`,
				gte(objects.createdAt, oneDayAgo),
			),
		)

	if ((dayRow?.count ?? 0) >= PER_IP_PER_DAY_CAP) {
		return { allowed: false, reason: 'ip_daily' }
	}

	return { allowed: true }
}
