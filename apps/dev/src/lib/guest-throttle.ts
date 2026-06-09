import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'
import { LANDING_GUESTS_WORKSPACE_ID } from './landing-guests'

// Returns the count of bet_draft objects for this guestSessionId since `since`.
// All drafts count toward the cap — including malformed ones — because the limit
// constrains LLM calls, not successful outputs.
//
// TOCTOU: this SELECT and the caller's subsequent INSERT are not atomic. Concurrent
// requests sharing the same session ID can all pass this check before any INSERT
// lands, overshooting the cap by at most N−1 (where N is simultaneous in-flight
// requests). The window is bounded by LLM stream latency (~seconds). The cap is
// a best-effort guard rather than a hard billing limit, so the race is explicitly
// accepted here rather than holding a long-lived transaction across the LLM call.
export async function checkGuestThrottle(
	db: Database,
	guestSessionId: string,
	cap: number,
	since: Date,
): Promise<{ allowed: boolean; count: number }> {
	const rows = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, LANDING_GUESTS_WORKSPACE_ID),
				eq(objects.type, 'bet_draft'),
				sql`${objects.metadata}->>'guestSessionId' = ${guestSessionId}`,
				gte(objects.createdAt, since),
			),
		)

	const count = Number(rows[0]?.count ?? 0)
	return { allowed: count < cap, count }
}
