// Snapshot-consistent cursor pagination for the workspace list endpoints.
//
// The same shape T3 introduced on `/api/objects` (see
// `apps/dev/src/routes/objects.ts:buildCursorConditions`), lifted out so the
// other flag-scoped list routes (`/api/actors`, `/api/relationships`,
// `/api/triggers`, `/api/files`, `/api/workspaces/:id/skills`) can carry
// identical seek semantics without each file duplicating the predicate.
//
// The keyset is always `(created_at, id)` — every candidate table has both
// columns and both are indexed, so a table-appropriate override was not
// needed. Callers must pair `cursor_created_at` with `cursor_id`; a lone
// `cursor_id` is silently ignored (matching the objects route) so a malformed
// cursor cannot degrade to an unbounded seek.

import { type Column, type SQL, and, gt, or, sql } from 'drizzle-orm'

export interface CreatedAtCursorQuery {
	order?: string
	snapshot_at?: string
	cursor_created_at?: string
	cursor_id?: string
}

/**
 * Postgres stores timestamps to the microsecond, but the cursor round-trips
 * through a JS Date (milliseconds). A bulk insert stamps every row with one
 * microsecond-precision `created_at`, so seeking past the truncated value
 * skips those tied rows under desc and replays them under asc. Ordering and
 * seeking on the millisecond-truncated value keeps the sort key and the cursor
 * on the same grid; `id` breaks the tie inside a millisecond. Callers must use
 * this for the `createdAt` leg of their `ORDER BY` too, or the sort and the
 * seek disagree.
 */
export function msCreatedAt(column: Column): SQL {
	return sql`date_trunc('milliseconds', ${column})`
}

/**
 * Predicate builder for a `(createdAt, id)` keyset cursor with an optional
 * `createdAt <= snapshot_at` upper bound. Pass in the table's `createdAt`
 * and `id` columns — the helper returns a list of Drizzle conditions to AND
 * into the caller's existing `where` clause.
 */
export function buildCreatedAtCursorConditions(
	columns: { createdAt: Column; id: Column },
	query: CreatedAtCursorQuery,
): SQL[] {
	const conditions: SQL[] = []
	const createdAt = msCreatedAt(columns.createdAt)
	if (query.snapshot_at) {
		const snapshot = new Date(query.snapshot_at).toISOString()
		conditions.push(sql`${createdAt} <= ${snapshot}::timestamptz`)
	}
	if (query.cursor_created_at && query.cursor_id) {
		const lastCa = sql`${new Date(query.cursor_created_at).toISOString()}::timestamptz`
		const lastId = query.cursor_id
		const past = query.order === 'asc' ? sql`>` : sql`<`
		const seek = or(
			sql`${createdAt} ${past} ${lastCa}`,
			and(sql`${createdAt} = ${lastCa}`, gt(columns.id, lastId)),
		)
		if (seek) conditions.push(seek)
	}
	return conditions
}

/** True when the caller supplied both halves of the keyset seek — signals
 *  that `offset` should be ignored so the predicate itself owns the skip. */
export function useKeysetSeek(query: CreatedAtCursorQuery): boolean {
	return Boolean(query.cursor_created_at && query.cursor_id)
}
