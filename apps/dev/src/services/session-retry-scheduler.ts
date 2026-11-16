/**
 * session-retry-scheduler.ts — §7.6 / §17.4 in the session-lifecycle tech spec.
 *
 * Ticks every 30 seconds. Reads sessions.retry_at (partial index
 * sessions_retry_at_idx: WHERE retry_at IS NOT NULL AND retried_session_id IS NULL).
 * For every due row: conditional UPDATE clears retry_at + marks the row as
 * about-to-be-retried, then fires startSession({retryOf, attemptNumber:N+1,
 * callerKind:'internal'}). Sets original.retried_session_id = new.id.
 *
 * One scheduler wins the row via the CAS on retried_session_id IS NULL. Cap
 * 5 attempts per §17.7 — an infinite retry loop on a permanently-broken
 * subscription would burn credits. Above the cap the row sits terminal-failed
 * with retry_at cleared.
 *
 * Killswitch env FEATURE_RETRY_SCHEDULER=0 skips the tick. The default is ON
 * so a fresh env, a preview, or a dev restart still gets the retry behaviour
 * — flip to '0' at runtime to disable without a code roll.
 */

import { and, sql as drizzleSql, eq, isNotNull, isNull, lte } from 'drizzle-orm'

import type { Database } from '@maskin/db'
import { events, sessions } from '@maskin/db'
import type { SessionResult } from '@maskin/shared'

import { logger } from '../lib/logger'
import { MAX_RETRY_ATTEMPTS } from '../lib/subscription-limit-reset'
import { alertOwnersOncePerDay } from './run-death-alerts'
import { startSession } from './session-lifecycle'
import { TaskSessionRestarter } from './task-session-restart'

const TICK_MS = 30_000
/** Reasons that mean the run died waiting on Claude's allowance. A lineage made only of these keeps the limit wording at the cap. */
const CLAUDE_LIMIT_CODES: ReadonlySet<string> = new Set([
	'session_limit',
	'weekly_limit',
	'opus_limit',
	'max_plan_rate_limit',
])
export { MAX_RETRY_ATTEMPTS }
export const KILLSWITCH_ENV_VAR = 'FEATURE_RETRY_SCHEDULER'

/** Row shape the scheduler cares about — every column it reads. */
type RetryableSession = {
	id: string
	workspaceId: string
	actorId: string
	conversationId: string | null
	triggerId: string | null
	initiatedFromObjectId: string | null
	actionPrompt: string
	config: Record<string, unknown> | null
	attemptNumber: number
	retryAt: Date | null
	result: SessionResult | null
	spawnedBySessionId: string | null
	spawnedByMessageId: number | null
}

/** Longest lineage the walk follows; the cap is 5 starts, so this is a bound, not a limit anyone meets. */
const MAX_LINEAGE_WALK = MAX_RETRY_ATTEMPTS + 2

export class SessionRetryScheduler {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private taskRestarter: TaskSessionRestarter

	constructor(
		private db: Database,
		private env: NodeJS.ProcessEnv = process.env,
	) {
		this.taskRestarter = new TaskSessionRestarter(db, env)
	}

	/** Start the tick loop. Idempotent — a second call is a no-op. */
	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('SessionRetryScheduler tick failed', { error: String(err) }),
			)
		}, TICK_MS)
		logger.info('SessionRetryScheduler started', { tickMs: TICK_MS })
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/** Public for test injection — normally called by the interval. */
	async tick(now: Date = new Date()): Promise<void> {
		if (this.running) return
		if (this.env[KILLSWITCH_ENV_VAR] === '0') return

		this.running = true
		try {
			const due = await this.db
				.select({
					id: sessions.id,
					workspaceId: sessions.workspaceId,
					actorId: sessions.actorId,
					conversationId: sessions.conversationId,
					triggerId: sessions.triggerId,
					initiatedFromObjectId: sessions.initiatedFromObjectId,
					actionPrompt: sessions.actionPrompt,
					config: sessions.config,
					attemptNumber: sessions.attemptNumber,
					retryAt: sessions.retryAt,
					result: sessions.result,
					spawnedBySessionId: sessions.spawnedBySessionId,
					spawnedByMessageId: sessions.spawnedByMessageId,
				})
				.from(sessions)
				.where(and(lte(sessions.retryAt, now), isNull(sessions.retriedSessionId)))
				.limit(50)

			for (const row of due) {
				await this.retryOne(row as RetryableSession).catch((err) =>
					logger.error('SessionRetryScheduler.retryOne failed', {
						sessionId: row.id,
						error: String(err),
					}),
				)
			}

			// Same tick, its own killswitch (FEATURE_TASK_SESSION_RESTART=0): restart agent
			// sessions that ended early while their task is still in progress.
			await this.taskRestarter
				.sweep(now)
				.catch((err) => logger.error('TaskSessionRestarter sweep failed', { error: String(err) }))
		} finally {
			this.running = false
		}
	}

	private async retryOne(row: RetryableSession): Promise<void> {
		// Cap-check first: §17.7 says attempt_number > 5 leaves retry_at cleared
		// with no retry. Clearing retry_at drops the row from the partial index
		// so we don't re-check it every tick.
		if (row.attemptNumber >= MAX_RETRY_ATTEMPTS) {
			await this.clearRetryAtForCap(row)
			return
		}

		// CAS: one scheduler wins. Guarding on BOTH retried_session_id IS NULL AND
		// retry_at IS NOT NULL means a competing scheduler that already claimed
		// this row (either by clearing retryAt in-flight below or by writing
		// retriedSessionId after startSession returned) loses this UPDATE
		// (rowCount === 0) and skips the row — two schedulers can't both fire a
		// startSession call for the same original session.
		const [claimed] = await this.db
			.update(sessions)
			.set({
				retryAt: null,
			})
			.where(
				and(
					eq(sessions.id, row.id),
					isNull(sessions.retriedSessionId),
					isNotNull(sessions.retryAt),
				),
			)
			.returning({ id: sessions.id })

		if (!claimed) return

		// Fire the retry. Same conversationId / triggerId so the reply lands on
		// the user's existing thread (§17.6). callerKind='internal' distinguishes
		// this from a user-initiated retry in analytics. sourceCommentEventId
		// is not passed through — it isn't a top-level sessions column (it's
		// folded into config.source_comment_event_id at start time), and the
		// original session's config already carries that key, so the retry
		// inherits it via config: row.config below.
		let newSessionId: string
		try {
			const handle = await startSession({
				workspaceId: row.workspaceId,
				actorId: row.actorId,
				callerKind: 'internal',
				actionPrompt: row.actionPrompt,
				config: row.config ?? undefined,
				conversationId: row.conversationId ?? undefined,
				triggerId: row.triggerId ?? undefined,
				// The retry keeps the originating object so its terminal telemetry and
				// any session_failed event still link back to what it was doing.
				initiatedFromObjectId: row.initiatedFromObjectId,
				retryOf: row.id,
				// Restore the failed session's /agent folder snapshot (same as the usage-limit failover); a missing snapshot starts fresh.
				parentSessionId: row.id,
				attemptNumber: row.attemptNumber + 1,
				// Whoever handed this work over still wants its result, so the rerun
				// reports back to them like the first attempt would have.
				spawnedBySessionId: row.spawnedBySessionId ?? undefined,
				spawnedByMessageId: row.spawnedByMessageId ?? undefined,
			})
			newSessionId = handle.sessionId
		} catch (err) {
			logger.error('SessionRetryScheduler failed to start retry session', {
				sessionId: row.id,
				attemptNumber: row.attemptNumber + 1,
				error: String(err),
			})
			// The claim above cleared retry_at, which drops the row from the partial index. A start
			// that throws (the wake hold does this by design) must not lose the retry: put the time
			// back so the next tick finds it. The attempt number is untouched, so a start that never
			// happened does not spend one. retried_session_id is still null here, so a competing
			// scheduler cannot have linked a retry in the meantime.
			await this.db
				.update(sessions)
				.set({ retryAt: row.retryAt })
				.where(
					and(eq(sessions.id, row.id), isNull(sessions.retriedSessionId), isNull(sessions.retryAt)),
				)
				.catch((restoreErr) =>
					logger.error('SessionRetryScheduler failed to restore retry_at after a failed start', {
						sessionId: row.id,
						error: String(restoreErr),
					}),
				)
			return
		}

		// Link the original to the retry so the MCP create_sub_chat wait loop and
		// get_session responses can follow the chain (§17.6).
		try {
			await this.db
				.update(sessions)
				.set({ retriedSessionId: newSessionId })
				.where(eq(sessions.id, row.id))
		} catch (err) {
			logger.error('SessionRetryScheduler failed to link retried_session_id on original', {
				originalSessionId: row.id,
				retriedSessionId: newSessionId,
				error: String(err),
			})
		}

		// §7.5 telemetry event — carries source + confidence from the parse
		// result. The parse result itself is not stored on the row today; when it
		// is (spec update), populate `data.source` / `data.confidence` from
		// row.result.failure_reason.reset_source instead of hard-coding advisory.
		await this.emitRetryEvent(row, 'session_retry_scheduled', {
			retriedSessionId: newSessionId,
			attemptNumber: row.attemptNumber + 1,
		})
	}

	private async clearRetryAtForCap(row: RetryableSession): Promise<void> {
		try {
			await this.db.update(sessions).set({ retryAt: null }).where(eq(sessions.id, row.id))
		} catch (err) {
			logger.warn('SessionRetryScheduler failed to clear retry_at on cap', {
				sessionId: row.id,
				error: String(err),
			})
		}
		await this.emitRetryEvent(row, 'session_retry_capped', {
			attemptNumber: row.attemptNumber,
			cap: MAX_RETRY_ATTEMPTS,
		})
		await this.alertOwnersOnCap(row)
	}

	/**
	 * A run that used up its retries must reach the workspace owner, not only the audit log.
	 * When every try in the lineage ended on a Claude limit the card says so; a mix of causes
	 * gets the neutral wording.
	 */
	private async alertOwnersOnCap(row: RetryableSession): Promise<void> {
		try {
			const codes = await this.lineageReasonCodes(row)
			const allLimits =
				codes.length > 0 && codes.every((c) => c !== null && CLAUDE_LIMIT_CODES.has(c))
			const starts = row.attemptNumber
			await alertOwnersOncePerDay(this.db, {
				workspaceId: row.workspaceId,
				causeKey: `retry_cap:${row.actorId}`,
				headline: allLimits
					? `Gave up waiting on Claude's limit after ${starts} starts`
					: `Gave up retrying after ${starts} starts`,
				rationale: allLimits
					? 'Every try ended on the Claude limit, so the work did not run. It will not start again by itself.'
					: 'The tries ended in different ways and the work did not run. It will not start again by itself.',
				sessionId: row.id,
			})
		} catch (err) {
			logger.warn('SessionRetryScheduler failed to alert owners on retry cap', {
				sessionId: row.id,
				error: String(err),
			})
		}
	}

	/** The failure reason code of the capped run and each run it was a retry of, newest first. */
	private async lineageReasonCodes(row: RetryableSession): Promise<Array<string | null>> {
		const codes: Array<string | null> = [row.result?.failure_reason?.reason_code ?? null]
		let parentId = await this.retryOfId(row.id)
		for (let i = 0; parentId && i < MAX_LINEAGE_WALK; i++) {
			const [parent] = await this.db
				.select({ result: sessions.result, retryOf: sessions.retryOf })
				.from(sessions)
				.where(eq(sessions.id, parentId))
				.limit(1)
			if (!parent) break
			codes.push((parent.result as SessionResult | null)?.failure_reason?.reason_code ?? null)
			parentId = parent.retryOf
		}
		return codes
	}

	private async retryOfId(sessionId: string): Promise<string | null> {
		const [r] = await this.db
			.select({ retryOf: sessions.retryOf })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		return r?.retryOf ?? null
	}

	private async emitRetryEvent(
		row: RetryableSession,
		action: 'session_retry_scheduled' | 'session_retry_capped',
		extra: Record<string, unknown>,
	): Promise<void> {
		// §7.5: the parse result the classifier used is stamped on
		// result.failure_reason.reset_source / .reset_confidence — carry them
		// through to the audit event so operators can trace WHICH signal fed the
		// retry (§17.2 sources 1-4). Absent when retry_at was seeded outside
		// the classifier path (e.g. test fixture); we omit the fields instead
		// of guessing.
		const failureReason = row.result?.failure_reason ?? null
		const source = failureReason?.reset_source
		const confidence = failureReason?.reset_confidence
		const resetMeta: Record<string, unknown> = {}
		if (source !== undefined) resetMeta.source = source
		if (confidence !== undefined) resetMeta.confidence = confidence

		try {
			await this.db.insert(events).values({
				workspaceId: row.workspaceId,
				actorId: row.actorId,
				action,
				entityType: 'session',
				entityId: row.id,
				data: {
					attemptNumber: row.attemptNumber,
					...resetMeta,
					...extra,
				},
			})
		} catch (err) {
			logger.warn('SessionRetryScheduler failed to insert audit event', {
				sessionId: row.id,
				action,
				error: String(err),
			})
		}
	}
}

/**
 * Helper for callers that don't want to instantiate the class — used by tests
 * that drive a single tick with a fake clock. Prod always goes through the
 * class-based scheduler wired in index.ts.
 */
export async function runSingleRetryTick(
	db: Database,
	now: Date = new Date(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const scheduler = new SessionRetryScheduler(db, env)
	await scheduler.tick(now)
}

// Suppress unused-warning for drizzleSql import — kept in reach so a future
// spec-widening (e.g. joining events for source/confidence lookup) can use it
// without another import edit.
void drizzleSql
