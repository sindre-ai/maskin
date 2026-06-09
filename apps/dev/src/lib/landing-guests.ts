import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'

export const LANDING_GUESTS_ACTOR_ID = '00000000-0000-0000-0001-000000000001'
export const LANDING_GUESTS_WORKSPACE_ID = '00000000-0000-0000-0001-000000000002'

/**
 * Returns the count of bet_draft objects created in the landing_guests workspace
 * since UTC midnight today. Used to enforce WORKSPACE_DAILY_DRAFT_CAP across all
 * instances — in-memory state isn't sufficient for a billing-grade guard.
 */
export async function getWorkspaceDailyDraftCount(db: Database): Promise<number> {
	const todayUtcMidnight = new Date()
	todayUtcMidnight.setUTCHours(0, 0, 0, 0)

	const rows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				gte(objects.createdAt, todayUtcMidnight),
			),
		)

	return Number(rows[0]?.count ?? 0)
}
