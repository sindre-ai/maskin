import type { Database, Transaction } from '@maskin/db'
import { linkedinActions } from '@maskin/db/schema'
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm'

/**
 * Server-side daily caps for the LinkedIn tools, counted from the permanent action log
 * (`linkedin_actions`), per connected account, over a rolling window.
 *
 * What counts toward a cap: rows with outcome `ok`, plus `pending` rows from the last two
 * minutes (a call that is in flight holds its slot; one that crashed before it was finalised
 * stops holding it after two minutes). `noop`, `refused_*` and `error` rows never count, so
 * "already withdrawn" and a refused call cost nothing.
 *
 * Two parallel calls must not both take the last slot. The count and the insert of the
 * caller's own `pending` row happen in one transaction that first takes a Postgres advisory
 * transaction lock on (integration, cap name), so the second caller waits, then sees the first
 * caller's row. `withActionLog` (action-log.ts) is the only caller.
 */

export const CAP_WINDOW_MS = 24 * 60 * 60 * 1000
export const PENDING_HOLDS_SLOT_MS = 2 * 60 * 1000

export interface CapSpec {
	/** Names the lock and the refusal message, e.g. `withdraw_invitation`. */
	name: string
	limit: number
	/**
	 * The tools whose rows count toward this cap. One entry for a per-tool cap; several for a
	 * shared budget such as profile views (get_profile, list_user_posts, get_company).
	 */
	tools: readonly string[]
	windowMs?: number
}

export type CapUsage = { within: true } | { within: false; resetAt: Date }

type Executor = Database | Transaction

/** Takes the cap's advisory lock for the rest of the transaction. */
export async function lockCap(tx: Executor, integrationId: string, capName: string): Promise<void> {
	await tx.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`linkedin_cap:${integrationId}:${capName}`}::text, 0))`,
	)
}

/**
 * Whether one more call fits under the cap. Over the cap, `resetAt` is when the oldest counted
 * row leaves the window, i.e. the earliest time a slot frees up. Call this under `lockCap`.
 */
export async function checkCap(
	tx: Executor,
	integrationId: string,
	cap: CapSpec,
	now: Date,
): Promise<CapUsage> {
	const windowMs = cap.windowMs ?? CAP_WINDOW_MS
	const windowStart = new Date(now.getTime() - windowMs)
	const pendingStart = new Date(now.getTime() - PENDING_HOLDS_SLOT_MS)
	// Only the oldest `limit` rows are needed: the cap is hit exactly when that many exist.
	const rows = await tx
		.select({ createdAt: linkedinActions.createdAt })
		.from(linkedinActions)
		.where(
			and(
				eq(linkedinActions.integrationId, integrationId),
				inArray(linkedinActions.tool, [...cap.tools]),
				gt(linkedinActions.createdAt, windowStart),
				or(
					eq(linkedinActions.outcome, 'ok'),
					and(eq(linkedinActions.outcome, 'pending'), gt(linkedinActions.createdAt, pendingStart)),
				),
			),
		)
		.orderBy(asc(linkedinActions.createdAt))
		.limit(cap.limit)
	const oldest = rows[0]
	if (rows.length < cap.limit || !oldest) return { within: true }
	return { within: false, resetAt: new Date(oldest.createdAt.getTime() + windowMs) }
}
