import type { Database } from '@maskin/db'
import { events, sessionDispatchAttempts, sessions } from '@maskin/db/schema'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { logger } from '../lib/logger'

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
 */

/** Outcome the dispatch callback reports to the queue. */
export type DispatchResult =
	| { kind: 'dispatched' }
	| { kind: 'no_capacity' }
	| { kind: 'transient_failure'; error: string }
	| { kind: 'permanent_failure'; error: string }

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
	/** Backoff when the queue is waiting on capacity. Default 10s. */
	noCapacityBackoffMs?: number
	/** How often the worker wakes up. Default 5s. */
	tickMs?: number
	/** Rows to process per tick. Default 5. */
	batchSize?: number
	/**
	 * How long a claimed row is leased before another worker may pick it up.
	 * Should comfortably exceed the slowest dispatch RTT. Default 60s.
	 */
	leaseMs?: number
}

const DEFAULTS = {
	maxAttempts: 5,
	baseBackoffMs: 5_000,
	maxBackoffMs: 5 * 60_000,
	noCapacityBackoffMs: 10_000,
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
		try {
			for (let i = 0; i < this.batchSize; i++) {
				const claimed = await this.claimOne()
				if (!claimed) break
				await this.processOne(claimed)
			}
		} finally {
			this.running = false
		}
	}

	/**
	 * Claim one ready row. Atomically selects the oldest `pending` row whose
	 * `next_attempt_at` is in the past, pushes its `next_attempt_at` forward
	 * by the lease, and returns it. Returns `null` when no row is ready.
	 *
	 * Holding the row lock only across the UPDATE — never across the dispatch
	 * itself — keeps tail latency on other workers bounded by the lease, not
	 * by the slowest in-flight HTTPS call.
	 */
	private async claimOne(): Promise<typeof sessionDispatchAttempts.$inferSelect | null> {
		return this.db.transaction(async (tx) => {
			const [candidate] = await tx
				.select()
				.from(sessionDispatchAttempts)
				.where(
					and(
						eq(sessionDispatchAttempts.status, 'pending'),
						lte(sessionDispatchAttempts.nextAttemptAt, new Date()),
					),
				)
				.orderBy(asc(sessionDispatchAttempts.nextAttemptAt))
				.limit(1)
				.for('update', { skipLocked: true })

			if (!candidate) return null

			const leaseUntil = new Date(Date.now() + this.leaseMs)
			const [leased] = await tx
				.update(sessionDispatchAttempts)
				.set({ nextAttemptAt: leaseUntil, updatedAt: new Date() })
				.where(eq(sessionDispatchAttempts.id, candidate.id))
				.returning()

			return leased ?? null
		})
	}

	private async processOne(row: typeof sessionDispatchAttempts.$inferSelect): Promise<void> {
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
				return
			case 'no_capacity':
				await this.handleNoCapacity(row)
				return
			case 'transient_failure':
				await this.handleTransientFailure(row, result.error)
				return
			case 'permanent_failure':
				await this.handlePermanentFailure(row, result.error)
				return
		}
	}

	private async handleDispatched(row: typeof sessionDispatchAttempts.$inferSelect): Promise<void> {
		await this.db.delete(sessionDispatchAttempts).where(eq(sessionDispatchAttempts.id, row.id))
		logger.info('Session dispatched', {
			sessionId: row.sessionId,
			attempt: row.attempt + 1,
		})
	}

	private async handleNoCapacity(row: typeof sessionDispatchAttempts.$inferSelect): Promise<void> {
		// Backpressure: every agent-server is full. Don't burn an attempt — just
		// delay the next try. A queue parked here will resume as soon as an
		// agent-server frees a slot.
		const nextAttemptAt = new Date(Date.now() + this.noCapacityBackoffMs)
		await this.db
			.update(sessionDispatchAttempts)
			.set({ nextAttemptAt, updatedAt: new Date() })
			.where(eq(sessionDispatchAttempts.id, row.id))
		logger.info('Session dispatch parked — no agent-server capacity', {
			sessionId: row.sessionId,
			nextAttemptAt: nextAttemptAt.toISOString(),
		})
	}

	private async handleTransientFailure(
		row: typeof sessionDispatchAttempts.$inferSelect,
		error: string,
	): Promise<void> {
		const attempt = row.attempt + 1
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
	): Promise<void> {
		await this.markRowFailed(row, error)
		await this.markSessionFailed(row.sessionId, `Permanent dispatch failure: ${error}`)
		logger.error('Session dispatch permanent failure', {
			sessionId: row.sessionId,
			error,
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
				attempt: row.attempt + 1,
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
	 */
	private async markSessionFailed(sessionId: string, errorMessage: string): Promise<void> {
		try {
			const [updated] = await this.db
				.update(sessions)
				.set({
					status: 'failed',
					result: { error: errorMessage },
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					and(eq(sessions.id, sessionId), sql`${sessions.status} NOT IN ('completed','failed')`),
				)
				.returning({
					id: sessions.id,
					workspaceId: sessions.workspaceId,
					actorId: sessions.actorId,
				})

			if (updated) {
				await this.db.insert(events).values({
					workspaceId: updated.workspaceId,
					actorId: updated.actorId,
					action: 'session_failed',
					entityType: 'session',
					entityId: updated.id,
					data: { error: errorMessage, source: 'dispatch_queue' },
				})
			}
		} catch (err) {
			// Surface but never throw — the row is already marked failed in the
			// queue, the worker should keep draining the rest of the batch.
			logger.error('Failed to mark session failed from dispatch queue', {
				sessionId,
				error: String(err),
			})
		}
	}

	private backoffMs(attempt: number): number {
		const exp = this.baseBackoffMs * 2 ** Math.max(0, attempt - 1)
		return Math.min(exp, this.maxBackoffMs)
	}
}
