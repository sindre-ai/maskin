import type { Database } from '@maskin/db'
import { sessionDispatchAttempts, sessions } from '@maskin/db/schema'
import type { SessionResultFailureReason } from '@maskin/shared'
import { and, asc, eq, lte, notInArray } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { type SettleDependencies, settleSession } from './session-lifecycle'

/**
 * Postgres-backed dispatch queue for session-start calls from apps/dev to
 * apps/agent-server. Absorbs backpressure (`no_capacity`) and retries failed
 * dispatches with exponential backoff. The same `idempotencyKey` is passed to
 * `dispatchFn` on every retry so the agent-server (and the side-effect layer)
 * dedupes any double-fire.
 *
 * One row per session_id. Re-enqueueing the same session is a no-op while a
 * row exists. The row is deleted on `dispatched` and marked `failed` on
 * `permanent_failure` or after `max_attempts` transient failures.
 *
 * An attempt is spent when a row is claimed (leased), not when its dispatch
 * returns. A start call that hangs — the tick times out, the lease expires, or
 * the process dies mid-call — therefore still costs one attempt, and a row
 * whose start call never returns reaches `max_attempts` and is failed instead
 * of being re-leased forever. `no_capacity` hands the attempt back: no start
 * call was made, so waiting for a slot never burns one.
 */

/** Outcome the dispatch callback reports to the queue. */
export type DispatchResult =
	| { kind: 'dispatched' }
	| { kind: 'no_capacity' }
	| { kind: 'transient_failure'; error: string }
	| {
			kind: 'permanent_failure'
			error: string
			/**
			 * Classification for the session row. When absent the queue falls back
			 * to the generic `dispatch_failed` reason — correct for "no agent-server
			 * took it", wrong for a failure the dispatcher already understands (e.g.
			 * the workspace has no LLM credentials), which is why callers that know
			 * better pass their own.
			 */
			failureReason?: SessionResultFailureReason
	  }

/**
 * Pluggable dispatch callback. Wired by T6's `SessionDispatcher` at startup.
 * Errors thrown by the callback are treated as `transient_failure` so a buggy
 * dispatcher does not silently drop a session.
 */
export type DispatchFn = (sessionId: string, idempotencyKey: string) => Promise<DispatchResult>

export interface SessionDispatchQueueOptions {
	/** Hard cap on transient-failure retries. Default 5. */
	maxAttempts?: number
	/** Base backoff in ms — `baseBackoffMs * 2^(attempt-1)`. Default 5_000. */
	baseBackoffMs?: number
	/** Upper bound on exponential backoff. Default 5 min. */
	maxBackoffMs?: number
	/**
	 * Backoff when the queue is waiting on capacity. Default 2s, under `tickMs`
	 * on purpose: every parked row must be ready again on the next tick, or a
	 * row still backing off when a slot frees loses it to a younger ready one.
	 */
	noCapacityBackoffMs?: number
	/** How often the worker wakes up. Default 5s. */
	tickMs?: number
	/**
	 * Start calls to make per tick. Default 5. A `no_capacity` result makes no
	 * start call, so it does not count against this.
	 */
	batchSize?: number
	/**
	 * How long a claimed row is leased before another worker may pick it up.
	 * Should comfortably exceed the slowest dispatch RTT. Default 60s.
	 */
	leaseMs?: number
	/**
	 * Upper bound on one tick. A batch that has not settled by then is
	 * abandoned and the next tick is allowed to run. Without it, a single
	 * awaited call that never settles — a DB query on a connection that died
	 * silently, a dispatch with no socket timeout — pins the `running` flag
	 * forever and every session in every workspace stalls in `starting`.
	 * Defaults to `leaseMs`, after which the abandoned row is reclaimable
	 * anyway; the stable idempotency key dedupes a late double-fire.
	 */
	tickTimeoutMs?: number
	/**
	 * Append a `system`-stream line to a session's transcript (SessionManager's
	 * insertSystemLog). Optional and best-effort — a log write must never stop
	 * the row from being marked failed. Without it a user watching a session
	 * that exhausted dispatch just sees the stream stop dead: no line, no
	 * reason, no hint that starting a new session is the recovery.
	 */
	appendSystemLog?: (sessionId: string, content: string) => Promise<void>
	/**
	 * Notified when a dispatch fails permanently for a reason the dispatcher
	 * already classified. Exists so a WORKSPACE-level cause — most importantly
	 * `not_logged_in`, "this workspace has no working LLM credentials" — can
	 * reach a listener that is able to stop re-provoking it.
	 *
	 * Why it is needed at all: `SessionDispatcher` *returns* its failures as
	 * values rather than throwing, and in production `SessionManager.launchContainer`
	 * enqueues and returns rather than launching, so nothing about a credential
	 * failure on this path propagates back to whoever created the session. The
	 * caller that created it (e.g. `TriggerRunner`) therefore never learns the
	 * workspace is unusable and keeps firing on schedule — which is exactly the
	 * flood this hook lets it stop (Sentry MASKIN-DEV-6).
	 *
	 * Best-effort and synchronous-safe: a throw here is caught and logged, never
	 * allowed to leave the session row un-failed.
	 */
	onPermanentFailure?: (info: {
		sessionId: string
		workspaceId: string
		/** `undefined` when the dispatcher gave no classification. */
		reasonCode?: string
		error: string
	}) => void
}

const DEFAULTS = {
	maxAttempts: 5,
	baseBackoffMs: 5_000,
	maxBackoffMs: 5 * 60_000,
	noCapacityBackoffMs: 2_000,
	tickMs: 5_000,
	batchSize: 5,
	leaseMs: 60_000,
} as const

/**
 * Stable idempotency key for every retry of a given session's dispatch.
 * The agent-server's POST `/sessions` endpoint (T6) and the receiver-side
 * idempotency middleware (T10) dedupe on this value, so a retried dispatch
 * never double-fires the session-start side effects.
 */
export function dispatchIdempotencyKey(sessionId: string): string {
	return `dispatch:${sessionId}`
}

/**
 * Shown to the user both as a `system` log line in the session transcript and
 * as `result.failure_reason.human_message` in the session detail panel. Says
 * what happened and what to do about it — dispatch exhaustion is recoverable,
 * and starting a new session is the recovery.
 */
const DISPATCH_FAILED_MESSAGE =
	'This session could not be started — no agent server accepted it after several attempts. Nothing was run. Start a new session to try again.'

/**
 * Shown when every start call for a session hung until its lease expired.
 * Says the start timed out, unlike DISPATCH_FAILED_MESSAGE, which blames
 * "no agent server accepted it".
 */
const START_TIMED_OUT_MESSAGE =
	'This session could not be started — the agent server did not answer the start request in time, after several attempts. Start a new session to try again.'

/** The only statuses a dispatch failure may still turn into a failed session. */
const DISPATCHABLE_STATUSES: readonly string[] = ['pending', 'queued', 'starting']

/** A leased queue row; `leaseExhausted` means no attempts were left to spend on it. */
type ClaimedRow = {
	row: typeof sessionDispatchAttempts.$inferSelect
	leaseExhausted: boolean
}

export class SessionDispatchQueue {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private readonly maxAttempts: number
	private readonly baseBackoffMs: number
	private readonly maxBackoffMs: number
	private readonly noCapacityBackoffMs: number
	private readonly tickMs: number
	private readonly batchSize: number
	private readonly leaseMs: number
	private readonly tickTimeoutMs: number
	private readonly appendSystemLog?: (sessionId: string, content: string) => Promise<void>
	private readonly onPermanentFailure?: SessionDispatchQueueOptions['onPermanentFailure']
	private readonly settleDeps: SettleDependencies

	constructor(
		private db: Database,
		private dispatchFn: DispatchFn,
		opts: SessionDispatchQueueOptions = {},
	) {
		this.maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts
		this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULTS.baseBackoffMs
		this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULTS.maxBackoffMs
		this.noCapacityBackoffMs = opts.noCapacityBackoffMs ?? DEFAULTS.noCapacityBackoffMs
		this.tickMs = opts.tickMs ?? DEFAULTS.tickMs
		this.batchSize = opts.batchSize ?? DEFAULTS.batchSize
		this.leaseMs = opts.leaseMs ?? DEFAULTS.leaseMs
		this.tickTimeoutMs = opts.tickTimeoutMs ?? this.leaseMs
		this.appendSystemLog = opts.appendSystemLog
		this.onPermanentFailure = opts.onPermanentFailure
		// Dispatch-queue sessions never reached an agent-server, so there is no
		// sandbox to stop and no `/agent` workspace to push. settleSession's
		// classification guard also skips pushAgentFiles for `dispatch_failure`,
		// but naming the no-op here keeps the intent legible.
		this.settleDeps = {
			db: this.db,
			stopSandbox: async () => 'skipped-none-live',
			pushAgentFiles: async () => 'skipped-no-workspace',
		}
	}

	/**
	 * Swap the dispatch callback after construction. Used at startup when T6's
	 * `SessionDispatcher` is wired in — the queue itself is owned by the dev
	 * service lifecycle, but the actual dispatcher arrives later in the boot
	 * sequence.
	 */
	setDispatchFn(fn: DispatchFn): void {
		this.dispatchFn = fn
	}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => {
			this.tick().catch((err) =>
				logger.error('Session dispatch queue tick failed', { error: String(err) }),
			)
		}, this.tickMs)
		this.timer.unref()
		setTimeout(() => this.tick().catch(() => undefined), 1_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	/**
	 * Insert a queue row for `sessionId` if none exists. Idempotent — re-calling
	 * with an in-flight session is a no-op so the existing retry schedule is not
	 * reset. Returns the resulting row (existing or new).
	 */
	async enqueue(
		sessionId: string,
		opts: { maxAttempts?: number; runAt?: Date } = {},
	): Promise<typeof sessionDispatchAttempts.$inferSelect> {
		const idempotencyKey = dispatchIdempotencyKey(sessionId)
		const runAt = opts.runAt ?? new Date()
		const maxAttempts = opts.maxAttempts ?? this.maxAttempts

		await this.db
			.insert(sessionDispatchAttempts)
			.values({
				sessionId,
				idempotencyKey,
				maxAttempts,
				nextAttemptAt: runAt,
			})
			.onConflictDoNothing({ target: sessionDispatchAttempts.sessionId })

		const [row] = await this.db
			.select()
			.from(sessionDispatchAttempts)
			.where(eq(sessionDispatchAttempts.sessionId, sessionId))
			.limit(1)
		if (!row) {
			throw new Error(`Failed to enqueue dispatch for session ${sessionId}`)
		}
		return row
	}

	/**
	 * Process up to `batchSize` ready rows. Each row is claimed inside a short
	 * transaction (SELECT FOR UPDATE SKIP LOCKED + UPDATE next_attempt_at to
	 * `now + leaseMs`), so the lock is released before the dispatch call. If
	 * this process crashes mid-dispatch the lease expires and another worker
	 * picks the row up on its next tick.
	 */
	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		let timer: NodeJS.Timeout | undefined
		let current: string | null = null
		const timedOut = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), this.tickTimeoutMs)
			timer.unref?.()
		})
		const batch = (async () => {
			// Rows already tried this tick. A parked row is not ready again until
			// its backoff passes, but a long tick must not reclaim it either.
			const tried: string[] = []
			let startCalls = 0
			while (startCalls < this.batchSize) {
				current = null
				const claimed = await this.claimOne(tried)
				if (!claimed) break
				current = claimed.row.sessionId
				tried.push(current)
				if (claimed.leaseExhausted) {
					await this.handleStartTimedOut(claimed.row)
					startCalls++
					continue
				}
				// A row that can't get a slot (say its sticky agent server is full)
				// must not use up the batch and starve the rows behind it.
				if (await this.processOne(claimed.row)) startCalls++
			}
			return 'done' as const
		})()
		try {
			if ((await Promise.race([batch, timedOut])) === 'timeout') {
				// The hung batch keeps running detached; swallow its eventual
				// rejection so it can't surface as an unhandled one.
				batch.catch(() => undefined)
				logger.error('Session dispatch queue tick timed out — abandoning batch', {
					tickTimeoutMs: this.tickTimeoutMs,
					stage: current ? 'dispatch' : 'claim',
					sessionId: current,
				})
			}
		} finally {
			clearTimeout(timer)
			this.running = false
		}
	}

	/**
	 * Claim one ready row. Atomically selects the oldest-created `pending` row
	 * whose `next_attempt_at` is in the past (that column says when a row is
	 * ready, never where it stands in line) and that is not in `exclude`, pushes its `next_attempt_at` forward
	 * by the lease, spends one attempt on it, and returns it. Returns `null`
	 * when no row is ready.
	 *
	 * The attempt is spent here so a start call that never returns still counts
	 * (see the file header). A row that comes back already at `max_attempts`
	 * can only mean that every earlier claim was never resolved — a resolved
	 * claim either deletes the row, fails it, or leaves it below the limit — so
	 * it is returned with `leaseExhausted` set and no further attempt is made.
	 *
	 * Holding the row lock only across the UPDATE — never across the dispatch
	 * itself — keeps tail latency on other workers bounded by the lease, not
	 * by the slowest in-flight HTTPS call.
	 */
	private async claimOne(exclude: string[]): Promise<ClaimedRow | null> {
		return this.db.transaction(async (tx) => {
			const [candidate] = await tx
				.select()
				.from(sessionDispatchAttempts)
				.where(
					and(
						eq(sessionDispatchAttempts.status, 'pending'),
						lte(sessionDispatchAttempts.nextAttemptAt, new Date()),
						exclude.length > 0 ? notInArray(sessionDispatchAttempts.sessionId, exclude) : undefined,
					),
				)
				.orderBy(asc(sessionDispatchAttempts.createdAt))
				.limit(1)
				.for('update', { skipLocked: true })

			if (!candidate) return null

			const leaseExhausted = candidate.attempt >= candidate.maxAttempts
			const leaseUntil = new Date(Date.now() + this.leaseMs)
			const [leased] = await tx
				.update(sessionDispatchAttempts)
				.set({
					nextAttemptAt: leaseUntil,
					// The row lock is held, so the read-then-write is safe.
					attempt: leaseExhausted ? candidate.attempt : candidate.attempt + 1,
					updatedAt: new Date(),
				})
				.where(eq(sessionDispatchAttempts.id, candidate.id))
				.returning()

			return leased ? { row: leased, leaseExhausted } : null
		})
	}

	/** Returns false when no start call was made (`no_capacity`). */
	private async processOne(row: typeof sessionDispatchAttempts.$inferSelect): Promise<boolean> {
		let result: DispatchResult
		try {
			result = await this.dispatchFn(row.sessionId, row.idempotencyKey)
		} catch (err) {
			result = {
				kind: 'transient_failure',
				error: err instanceof Error ? err.message : String(err),
			}
		}

		switch (result.kind) {
			case 'dispatched':
				await this.handleDispatched(row)
				return true
			case 'no_capacity':
				await this.handleNoCapacity(row)
				return false
			case 'transient_failure':
				await this.handleTransientFailure(row, result.error)
				return true
			case 'permanent_failure':
				await this.handlePermanentFailure(row, result.error, result.failureReason)
				return true
		}
	}

	private async handleDispatched(row: typeof sessionDispatchAttempts.$inferSelect): Promise<void> {
		await this.db.delete(sessionDispatchAttempts).where(eq(sessionDispatchAttempts.id, row.id))
		logger.info('Session dispatched', {
			sessionId: row.sessionId,
			attempt: row.attempt,
		})
	}

	private async handleNoCapacity(row: typeof sessionDispatchAttempts.$inferSelect): Promise<void> {
		// Backpressure: every agent-server is full. No start call was made, so
		// hand back the attempt claimOne spent and just delay the next try. A
		// queue parked here will resume as soon as an agent-server frees a slot.
		// Compare-and-set on the attempt count: if a late result from an
		// abandoned tick lands after a newer claim, the newer claim owns the row.
		const nextAttemptAt = new Date(Date.now() + this.noCapacityBackoffMs)
		await this.db
			.update(sessionDispatchAttempts)
			.set({ attempt: row.attempt - 1, nextAttemptAt, updatedAt: new Date() })
			.where(
				and(
					eq(sessionDispatchAttempts.id, row.id),
					eq(sessionDispatchAttempts.attempt, row.attempt),
				),
			)
		logger.info('Session dispatch parked — no agent-server capacity', {
			sessionId: row.sessionId,
			nextAttemptAt: nextAttemptAt.toISOString(),
		})
	}

	private async handleTransientFailure(
		row: typeof sessionDispatchAttempts.$inferSelect,
		error: string,
	): Promise<void> {
		const attempt = row.attempt
		if (attempt >= row.maxAttempts) {
			await this.markRowFailed(row, error)
			await this.markSessionFailed(
				row.sessionId,
				`Dispatch exhausted after ${attempt} attempts: ${error}`,
			)
			logger.error('Session dispatch exhausted', {
				sessionId: row.sessionId,
				attempt,
				maxAttempts: row.maxAttempts,
				error,
			})
			return
		}
		const nextAttemptAt = new Date(Date.now() + this.backoffMs(attempt))
		await this.db
			.update(sessionDispatchAttempts)
			.set({
				attempt,
				lastError: error,
				nextAttemptAt,
				updatedAt: new Date(),
			})
			.where(eq(sessionDispatchAttempts.id, row.id))
		logger.warn('Session dispatch transient failure — will retry', {
			sessionId: row.sessionId,
			attempt,
			maxAttempts: row.maxAttempts,
			nextAttemptAt: nextAttemptAt.toISOString(),
			error,
		})
	}

	private async handlePermanentFailure(
		row: typeof sessionDispatchAttempts.$inferSelect,
		error: string,
		failureReason?: SessionResultFailureReason,
	): Promise<void> {
		await this.markRowFailed(row, error)
		const workspaceId = await this.markSessionFailed(
			row.sessionId,
			`Permanent dispatch failure: ${error}`,
			failureReason,
		)
		logger.error('Session dispatch permanent failure', {
			sessionId: row.sessionId,
			error,
		})

		// `workspaceId` is null only when the session row was already terminal —
		// the dispatcher raced us to it — in which case there is no live session
		// to attribute the workspace state to and nothing useful to notify about.
		if (workspaceId && this.onPermanentFailure) {
			try {
				this.onPermanentFailure({
					sessionId: row.sessionId,
					workspaceId,
					reasonCode: failureReason?.reason_code,
					error,
				})
			} catch (err) {
				logger.warn('onPermanentFailure hook threw', {
					sessionId: row.sessionId,
					error: String(err),
				})
			}
		}
	}

	/**
	 * Give up on a row whose start call never returned on any of its
	 * `max_attempts` claims. Same terminal path as every other give-up; only
	 * the message differs, so the user is told the start timed out.
	 */
	private async handleStartTimedOut(
		row: typeof sessionDispatchAttempts.$inferSelect,
	): Promise<void> {
		const error = `Dispatch start timed out after ${row.attempt} attempts: the agent server did not answer before the lease expired`
		await this.markRowFailed(row, error)
		await this.markSessionFailed(row.sessionId, error, {
			provider: 'agent-server',
			reason_code: 'dispatch_failed',
			human_message: START_TIMED_OUT_MESSAGE,
			http_status: null,
			reset_at: null,
			verbatim_output: error,
		})
		logger.error('Session dispatch start timed out', {
			sessionId: row.sessionId,
			attempt: row.attempt,
			maxAttempts: row.maxAttempts,
		})
	}

	private async markRowFailed(
		row: typeof sessionDispatchAttempts.$inferSelect,
		error: string,
	): Promise<void> {
		await this.db
			.update(sessionDispatchAttempts)
			.set({
				status: 'failed',
				lastError: error,
				updatedAt: new Date(),
			})
			.where(eq(sessionDispatchAttempts.id, row.id))
	}

	/**
	 * Terminal failure path: mark the session row failed and emit a
	 * `session_failed` event so the recovery UI surfaces it just like any other
	 * runtime failure. If the session row was already terminal (the dispatcher
	 * raced us to it) the UPDATE matches zero rows and the event still records
	 * the dispatch-side observation.
	 *
	 * Returns the failed session's workspace id, or null when this call did not
	 * fail a live session — the UPDATE matched nothing (already terminal) or the
	 * UPDATE itself threw. Deliberately NOT null for a failure of the event
	 * insert or the system-log append that follow it: those are reporting on a
	 * session this call really did fail, and the caller uses a non-null return
	 * to open a workspace-level pause.
	 */
	private async markSessionFailed(
		sessionId: string,
		errorMessage: string,
		failureReason?: SessionResultFailureReason,
	): Promise<string | null> {
		// A bare `result.error` string renders nowhere: the session detail panel's
		// FailureCard reads `result.failure_reason`, and use-conversation-activity
		// reads `failure_reason.human_message`. Without this the user's session
		// simply stopped, with the real explanation visible only in Sentry
		// (MASKIN-DEV-4). `dispatch_failed` is the right default for "no
		// agent-server took it" — a caller that already knows the cause passes
		// its own, so a credential failure doesn't masquerade as a dispatch one.
		const resolvedFailureReason: SessionResultFailureReason = failureReason ?? {
			provider: 'agent-server',
			reason_code: 'dispatch_failed',
			human_message: DISPATCH_FAILED_MESSAGE,
			http_status: null,
			reset_at: null,
			verbatim_output: errorMessage,
		}
		// settleSession is the only writer of `sessions.status` for terminal
		// values. It runs the conditional UPDATE (CAS on non-terminal), inserts
		// the `session_failed` audit row, and returns `alreadySettled: true` on
		// a raced write — the caller's null-return semantics are preserved by
		// re-reading `workspaceId` from the row post-settle only when settle
		// actually flipped it.
		let settled: Awaited<ReturnType<typeof settleSession>>
		try {
			// settleSession only refuses the four terminal statuses, so without
			// this check a running, paused or waiting_for_input session would be
			// overwritten to failed by a dispatch worker that lost the race for it.
			const [current] = await this.db
				.select({ status: sessions.status })
				.from(sessions)
				.where(eq(sessions.id, sessionId))
				.limit(1)
			if (current && !DISPATCHABLE_STATUSES.includes(current.status)) {
				logger.info('Dispatch failure ignored — session already left the dispatchable states', {
					sessionId,
					status: current.status,
				})
				return null
			}
			settled = await settleSession(
				sessionId,
				{
					kind: 'fail',
					classification: 'dispatch_failure',
					source: 'dispatch-queue',
					reason: errorMessage,
					exitCode: 0,
					failureReason: resolvedFailureReason,
				},
				this.settleDeps,
			)
		} catch (err) {
			// Surface but never throw — the row is already marked failed in the
			// queue, the worker should keep draining the rest of the batch.
			logger.error('Failed to mark session failed from dispatch queue', {
				sessionId,
				error: String(err),
			})
			return null
		}

		if (settled.alreadySettled) return null

		// Re-read workspaceId — settleSession did the UPDATE but doesn't return
		// the row's columns; the null-return contract in the docstring above
		// keys off a live transition, and callers use the returned workspaceId
		// to open the workspace-level pause.
		const [workspaceRow] = await this.db
			.select({ workspaceId: sessions.workspaceId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		if (!workspaceRow) return null

		// Best-effort, and deliberately after the row is already failed: a
		// log-write failure must not leave the session stuck non-terminal.
		if (this.appendSystemLog) {
			try {
				await this.appendSystemLog(sessionId, resolvedFailureReason.human_message)
			} catch (err) {
				logger.warn('Failed to append dispatch-failure log line', {
					sessionId,
					error: String(err),
				})
			}
		}

		return workspaceRow.workspaceId
	}

	private backoffMs(attempt: number): number {
		const exp = this.baseBackoffMs * 2 ** Math.max(0, attempt - 1)
		return Math.min(exp, this.maxBackoffMs)
	}
}
