import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'

/**
 * Status-based execution permissions for the loop lifecycle ladder (T4 of
 * bet/loop-lifecycle-status-ladder). Consolidates the two runtime gates that
 * loop status must enforce at the session boundary:
 *
 *   - Blocking gate: `draft | paused | archived` → no session may be created.
 *   - Supervised gate: `supervised` → sessions run, but each terminal output
 *     is held in the T7 approval queue before delivery.
 *
 * `pilot` and `live` are unconditional pass-through: sessions run and outputs
 * fan out immediately.
 *
 * This module owns the reverse-lookup from trigger id back to parent loop —
 * loops keep membership as `metadata.trigger_ids: [uuid, …]`, the same source
 * of truth `apps/dev/src/routes/loops.ts` reads for the loop list. When T1
 * lands the same helper is the up-stream gate inside `TriggerRunner`; T4 wires
 * it inside `SessionManager` as defence-in-depth so every `createSession` call
 * site — TriggerRunner (event/cron/reminder), `POST /api/sessions`, and the
 * internal Claude-backup retry — enforces the same block.
 */

/**
 * Loop statuses that block session creation. Hardcoded here rather than
 * imported from `@maskin/shared` because T2 (which will export
 * `LOOP_STATUSES_BLOCKING_SESSIONS` alongside the widened enum) is on a
 * separate PR that hasn't merged into this bet branch yet. The name and
 * membership match T2's constant, so this file becomes a candidate to switch
 * to the shared import once T2 lands.
 */
const BLOCKING_STATUSES = new Set(['draft', 'paused', 'archived'])
const SUPERVISED_STATUS = 'supervised'

export type LoopExecutionDecision = 'allow' | 'block' | 'supervised'

export interface LoopExecutionGate {
	decision: LoopExecutionDecision
	/**
	 * Parent loop id, when the trigger is owned by a loop and the loop row was
	 * found in-workspace. Null when the trigger isn't tied to a loop — the
	 * gate returns `allow` in that case, since a standalone trigger has no
	 * lifecycle to enforce.
	 */
	loopId: string | null
	/** Raw loop status when a loop was found; null when no loop owns the trigger. */
	status: string | null
}

/**
 * Look up the parent loop for a trigger id and decide whether a session may
 * be created (and if so, whether its output must be held for approval).
 *
 * `triggerId` may be null/undefined — callers include `POST /api/sessions`,
 * which sometimes passes `undefined` for a hand-created session. In that
 * case no loop is possible and the gate returns `allow` immediately.
 *
 * A trigger that isn't in any loop's `metadata.trigger_ids` also returns
 * `allow` — standalone triggers are legitimate and pre-date this feature.
 */
export async function resolveLoopExecutionGate(
	db: Database,
	workspaceId: string,
	triggerId: string | null | undefined,
): Promise<LoopExecutionGate> {
	if (!triggerId) return { decision: 'allow', loopId: null, status: null }

	// `metadata->'trigger_ids' ? $triggerId` uses the jsonb `?` operator to
	// test membership in the trigger_ids array; workspace + type filters keep
	// the scan bounded to a small slice and hit the existing
	// (workspace_id, type, status) index. Returns at most one row — a trigger
	// only belongs to a single loop by construction (the mcp create_loop /
	// update_loop tools own that invariant).
	const [row] = await db
		.select({ id: objects.id, status: objects.status })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'loop'),
				sql`${objects.metadata}->'trigger_ids' ? ${triggerId}`,
			),
		)
		.limit(1)

	if (!row) return { decision: 'allow', loopId: null, status: null }

	if (BLOCKING_STATUSES.has(row.status)) {
		return { decision: 'block', loopId: row.id, status: row.status }
	}
	if (row.status === SUPERVISED_STATUS) {
		return { decision: 'supervised', loopId: row.id, status: row.status }
	}
	return { decision: 'allow', loopId: row.id, status: row.status }
}

/**
 * Thrown by `SessionManager.createSession` when the trigger's parent loop is
 * in a blocking status. TriggerRunner's existing `.catch` on every
 * createSession call swallows it with a logged audit event — a trigger firing
 * against a paused loop is expected behaviour, not an error. The
 * `POST /api/sessions` route catches it and returns 409 with `loop_id` +
 * `status` so a caller (UI or a Loop Curator agent) can distinguish "you
 * asked to run a session that's currently gated" from a real 500.
 */
export class LoopExecutionBlockedError extends Error {
	readonly loopId: string
	readonly loopStatus: string

	constructor(loopId: string, loopStatus: string) {
		super(`Loop ${loopId} is in status '${loopStatus}' — session creation blocked`)
		this.name = 'LoopExecutionBlockedError'
		this.loopId = loopId
		this.loopStatus = loopStatus
	}
}
