/**
 * held-session-release.ts — lets sessions held at the daily limit go (daily budget 1b, task "Park
 * work at the daily limit, run it later").
 *
 * A held session is a row in `starting` / `waiting_for_machine` with `config.held` set and a
 * dispatch-queue row that is not due yet (`SessionManager.holdSession`). This pass runs on every
 * dispatch-queue tick (throttled) and, per workspace:
 *   1. looks at today's spend against the target (the number the morning card shows). Still at or
 *      over the stop-at line: nothing is let go. No target any more, or spend under the line (a new
 *      day, a raised target): there is room.
 *   2. lets go at most RELEASE_BATCH sessions per pass, and never more than the workspace's free
 *      start slots, most important first (urgent, normal, low), oldest first within one level.
 *      Cost is written when a run ends, so letting everything go at once could blow far past the
 *      target; a few per pass keeps the day close to it.
 * Letting go is two writes: `config.held.released_at` (so the session counts against the start
 * limit from now on) and the queue row made due (`SessionDispatchQueue.makeDue`). The dispatcher
 * starts it from there like any session.
 *
 * Backstop: the queue row of a held session comes due on its own shortly after the next local day
 * starts (`HELD_BACKSTOP_AFTER_DAY_START_MS`), so held work never waits past the next day even if
 * this pass is not running.
 */
import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { IMPORTANCE_RANK } from '@maskin/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { recordSessionAdmission } from './daily-budget-events'
import {
	DAILY_BUDGET_HOLD_KILLSWITCH_ENV_VAR,
	type HeldConfig,
	heldNotReleased,
	readDayAgainstTarget,
	stopLineReached,
} from './daily-budget-hold'

/** Most sessions let go per workspace per pass. */
export const RELEASE_BATCH = 5
/** The pass runs at most this often, whatever the queue's tick is. */
export const RELEASE_MIN_INTERVAL_MS = 15_000
/** Held sessions read per pass; the oldest of the most important go first. */
const READ_LIMIT = 200

export interface HeldSessionReleaseDeps {
	db: Database
	/** Make the queue row of a held session due now. */
	makeDue: (sessionId: string) => Promise<boolean>
	/** How many more sessions the workspace may start (SessionManager.freeStartSlots). */
	freeStartSlots: (workspaceId: string) => Promise<number>
}

/** Lower first. A held session is `normal` or `low`; an unreadable value counts as `normal`. */
const heldImportanceRank = sql`CASE ${sessions.config}->'held'->>'importance'
	WHEN 'low' THEN ${sql.raw(String(IMPORTANCE_RANK.low))}
	ELSE ${sql.raw(String(IMPORTANCE_RANK.normal))} END`

/**
 * One pass. Returns how many sessions were let go. Never throws on one workspace's failure: that
 * workspace is skipped and logged, the others carry on.
 */
export async function releaseHeldSessions(
	deps: HeldSessionReleaseDeps,
	now: Date = new Date(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const { db } = deps
	// With the hold switched off, no new work is held, but what is already held still has to go.
	const held = await db
		.select({
			id: sessions.id,
			workspaceId: sessions.workspaceId,
			actorId: sessions.actorId,
			triggerId: sessions.triggerId,
			config: sessions.config,
		})
		.from(sessions)
		.where(and(eq(sessions.status, 'starting'), heldNotReleased))
		.orderBy(heldImportanceRank, asc(sessions.createdAt))
		.limit(READ_LIMIT)
	if (held.length === 0) return 0

	const byWorkspace = new Map<string, typeof held>()
	for (const row of held) {
		const list = byWorkspace.get(row.workspaceId)
		if (list) list.push(row)
		else byWorkspace.set(row.workspaceId, [row])
	}

	const switchedOff = env[DAILY_BUDGET_HOLD_KILLSWITCH_ENV_VAR] === '0'
	let released = 0
	for (const [workspaceId, rows] of byWorkspace) {
		try {
			if (!switchedOff) {
				const day = await readDayAgainstTarget(db, workspaceId, now)
				if (day && stopLineReached(day)) continue
			}
			const room = Math.min(RELEASE_BATCH, await deps.freeStartSlots(workspaceId))
			for (const row of rows.slice(0, Math.max(0, room))) {
				if (await releaseOne(deps, row, now)) released++
			}
		} catch (err) {
			logger.warn('Releasing held sessions failed for a workspace', {
				workspaceId,
				error: String(err),
			})
		}
	}
	return released
}

async function releaseOne(
	deps: HeldSessionReleaseDeps,
	row: {
		id: string
		workspaceId: string
		actorId: string
		triggerId: string | null
		config: unknown
	},
	now: Date,
): Promise<boolean> {
	// Compare-and-set: one pass (or one replica) lets a session go, never two.
	const [claimed] = await deps.db
		.update(sessions)
		.set({
			config: sql`jsonb_set(${sessions.config}, '{held,released_at}', to_jsonb(${now.toISOString()}::text))`,
		})
		.where(and(eq(sessions.id, row.id), eq(sessions.status, 'starting'), heldNotReleased))
		.returning({ id: sessions.id })
	if (!claimed) return false

	const config = (row.config ?? {}) as { held?: HeldConfig; start_reason?: string }
	const heldAt = config.held?.held_at ? new Date(config.held.held_at) : null
	await deps.makeDue(row.id)
	logger.info(`Held session let go: ${row.id}`, { workspaceId: row.workspaceId })
	void recordSessionAdmission(deps.db, {
		sessionId: row.id,
		workspaceId: row.workspaceId,
		actorId: row.actorId,
		triggerId: row.triggerId,
		callerKind: 'held_release',
		humanFacing: false,
		startReason: config.start_reason,
		importance: config.held?.importance ?? 'normal',
		decision: 'admitted',
		heldForMs:
			heldAt && !Number.isNaN(heldAt.getTime()) ? now.getTime() - heldAt.getTime() : undefined,
	})
	return true
}

/** The pass as a callback for the dispatch queue's `beforeClaim`, throttled and never throwing. */
export function createHeldSessionRelease(deps: HeldSessionReleaseDeps): () => Promise<void> {
	let lastRunAt = 0
	return async () => {
		const now = Date.now()
		if (now - lastRunAt < RELEASE_MIN_INTERVAL_MS) return
		lastRunAt = now
		await releaseHeldSessions(deps, new Date(now))
	}
}
