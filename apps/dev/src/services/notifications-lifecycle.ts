import type { Database } from '@maskin/db'
import { events, notifications } from '@maskin/db/schema'
import { and, asc, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { wakeSourceAgent } from '../lib/notifications/wake-source-agent'
import type { SessionManager } from './session-manager'

// Wake reaper runs at 5s so a deferred wake (dispatch_at = now + 6s) has a
// worst-case latency of ~11s from the human's respond to the agent seeing
// the response. Anything longer here would leave the user staring at
// "waiting on agent" past the point where their reverse window closes.
const DEFAULT_WAKE_TICK_MS = 5_000

// Expiry sweep runs less often — expirations are wall-clock deadlines
// measured in minutes/hours, so 60s granularity is fine and it keeps the
// scan off the hot path.
const DEFAULT_EXPIRY_TICK_MS = 60_000

// Rows processed per tick. Keeps a single stuck row from blocking every
// pending wake, and caps the lock footprint under contention.
const DEFAULT_BATCH_SIZE = 25

// Circuit-breaker: after this many consecutive tick failures, log an
// error-level alert so the on-call surface picks it up. The loop keeps
// running (with backoff) — it doesn't self-disable, because "wake never
// fires" is a worse failure mode than "wake noisily retries".
const CIRCUIT_BREAKER_THRESHOLD = 3

const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 5 * 60_000

function calculateBackoffMs(failureCount: number): number {
	return Math.min(BASE_BACKOFF_MS * 2 ** (failureCount - 1), MAX_BACKOFF_MS)
}

export interface NotificationsLifecycleOptions {
	wakeTickMs?: number
	expiryTickMs?: number
	batchSize?: number
}

type NotificationRow = typeof notifications.$inferSelect

interface LoopState {
	failures: number
	backoffUntil: Date | null
	running: boolean
}

// Runs two independent loops against the `notifications` table:
//   1. Wake reaper — every `wakeTickMs`, finds rows whose deferred-wake
//      deadline has elapsed and hands them to `wakeSourceAgent`.
//   2. Expiry sweep — every `expiryTickMs`, finds rows whose `expires_at`
//      has elapsed without a decision, applies their `default_action` as a
//      synthetic response, and writes a threaded comment on the underlying
//      object naming the auto-applied action.
//
// Both loops use `SELECT ... FOR UPDATE SKIP LOCKED` so multiple app
// instances can coexist without stepping on each other. The reaper is
// idempotent under restart — `wake_dispatched` flips inside the same
// transaction that claims the row, so a crash between claim and dispatch
// leaves the row eligible for the next tick.
export class NotificationsLifecycle {
	private wakeTimer: NodeJS.Timeout | null = null
	private expiryTimer: NodeJS.Timeout | null = null
	private readonly wakeTickMs: number
	private readonly expiryTickMs: number
	private readonly batchSize: number
	private readonly wakeState: LoopState = { failures: 0, backoffUntil: null, running: false }
	private readonly expiryState: LoopState = { failures: 0, backoffUntil: null, running: false }

	constructor(
		private db: Database,
		private sessionManager: SessionManager,
		opts: NotificationsLifecycleOptions = {},
	) {
		this.wakeTickMs = opts.wakeTickMs ?? DEFAULT_WAKE_TICK_MS
		this.expiryTickMs = opts.expiryTickMs ?? DEFAULT_EXPIRY_TICK_MS
		this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
	}

	start(): void {
		if (this.wakeTimer || this.expiryTimer) return
		this.wakeTimer = setInterval(() => {
			this.runWakeReaper().catch((err) =>
				logger.error('Wake reaper tick threw unexpectedly', { error: String(err) }),
			)
		}, this.wakeTickMs)
		this.wakeTimer.unref()

		this.expiryTimer = setInterval(() => {
			this.runExpirySweep().catch((err) =>
				logger.error('Expiry sweep tick threw unexpectedly', { error: String(err) }),
			)
		}, this.expiryTickMs)
		this.expiryTimer.unref()
	}

	stop(): void {
		if (this.wakeTimer) {
			clearInterval(this.wakeTimer)
			this.wakeTimer = null
		}
		if (this.expiryTimer) {
			clearInterval(this.expiryTimer)
			this.expiryTimer = null
		}
	}

	// Exported for tests: run one wake reaper pass and return the number of
	// notifications successfully dispatched.
	async runWakeReaper(): Promise<number> {
		if (this.wakeState.running) return 0
		if (this.wakeState.backoffUntil && this.wakeState.backoffUntil > new Date()) return 0
		this.wakeState.running = true
		let dispatched = 0
		try {
			const claimed = await this.claimWakeCandidates()
			for (const row of claimed) {
				try {
					await wakeSourceAgent({
						sessionManager: this.sessionManager,
						db: this.db,
						workspaceId: row.workspaceId,
						sourceActorId: row.sourceActorId,
						linkedSessionId: row.sessionId,
						notificationId: row.id,
						title: row.title,
						content: row.content,
						response: (row.metadata as Record<string, unknown> | null)?.response ?? null,
						createdBy: row.sourceActorId,
					})
					dispatched++
				} catch (err) {
					// Per-row failure: log and leave the row for the next tick.
					// wake_dispatched is already true (claim step), so we don't
					// retry the same row indefinitely — a stuck source agent
					// won't jam every other wake. Operators can inspect logs and
					// null out wake_dispatched by hand if a genuine retry is
					// wanted.
					logger.error('Wake reaper: wakeSourceAgent failed for notification', {
						notificationId: row.id,
						sourceActorId: row.sourceActorId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			this.resetLoop(this.wakeState, 'Wake reaper')
			return dispatched
		} catch (err) {
			this.recordLoopFailure(this.wakeState, 'Wake reaper', err)
			return dispatched
		} finally {
			this.wakeState.running = false
		}
	}

	// Exported for tests: run one expiry sweep pass and return the number of
	// notifications successfully expired.
	async runExpirySweep(): Promise<number> {
		if (this.expiryState.running) return 0
		if (this.expiryState.backoffUntil && this.expiryState.backoffUntil > new Date()) return 0
		this.expiryState.running = true
		let expired = 0
		try {
			const claimed = await this.claimExpiryCandidates()
			for (const row of claimed) {
				try {
					await this.applyExpiryToRow(row)
					expired++
				} catch (err) {
					logger.error('Expiry sweep: failed to expire notification', {
						notificationId: row.id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			this.resetLoop(this.expiryState, 'Expiry sweep')
			return expired
		} catch (err) {
			this.recordLoopFailure(this.expiryState, 'Expiry sweep', err)
			return expired
		} finally {
			this.expiryState.running = false
		}
	}

	// Selects up to `batchSize` wake-ready rows and flips `wake_dispatched`
	// to true inside the same transaction. The flip is what makes the reaper
	// safe to run in parallel across app instances — the partial index
	// (`WHERE dispatch_at IS NOT NULL AND wake_dispatched = false`) excludes
	// rows the moment they're claimed.
	private async claimWakeCandidates(): Promise<NotificationRow[]> {
		return this.db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(notifications)
				.where(
					and(
						isNotNull(notifications.dispatchAt),
						eq(notifications.wakeDispatched, false),
						lt(notifications.dispatchAt, new Date()),
					),
				)
				.orderBy(asc(notifications.dispatchAt))
				.limit(this.batchSize)
				.for('update', { skipLocked: true })

			if (rows.length === 0) return []

			await tx
				.update(notifications)
				.set({ wakeDispatched: true, updatedAt: new Date() })
				.where(
					inArray(
						notifications.id,
						rows.map((r) => r.id),
					),
				)

			return rows
		})
	}

	// Selects up to `batchSize` expired-and-still-open rows and transitions
	// them to `expired` inside the same transaction. Same SKIP LOCKED
	// pattern; same idempotency guarantee (rows leave the partial index the
	// moment the status flips).
	private async claimExpiryCandidates(): Promise<NotificationRow[]> {
		return this.db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(notifications)
				.where(
					and(
						isNotNull(notifications.expiresAt),
						inArray(notifications.status, ['pending', 'seen']),
						lt(notifications.expiresAt, new Date()),
					),
				)
				.orderBy(asc(notifications.expiresAt))
				.limit(this.batchSize)
				.for('update', { skipLocked: true })

			if (rows.length === 0) return []

			await tx
				.update(notifications)
				.set({ status: 'expired', updatedAt: new Date() })
				.where(
					inArray(
						notifications.id,
						rows.map((r) => r.id),
					),
				)

			return rows
		})
	}

	// For each expired row, write a synthetic `expired` event with the
	// applied default_action, and post a `commented` event on the underlying
	// object (if any) so the timeline reflects the auto-decision.
	private async applyExpiryToRow(row: NotificationRow): Promise<void> {
		const defaultAction = row.defaultAction
		const optionLabel = resolveOptionLabel(row.metadata, defaultAction)

		await this.db.insert(events).values({
			workspaceId: row.workspaceId,
			actorId: row.sourceActorId,
			action: 'expired',
			entityType: 'notification',
			entityId: row.id,
			data: {
				defaultAction,
				optionLabel,
				expiredAt: new Date().toISOString(),
			},
		})

		if (!row.objectId) return

		const commentBody = defaultAction
			? `Notification "${row.title}" expired at ${new Date().toISOString()} — auto-applied default action "${optionLabel ?? defaultAction}".`
			: `Notification "${row.title}" expired at ${new Date().toISOString()} — no default action was configured.`

		await this.db.insert(events).values({
			workspaceId: row.workspaceId,
			actorId: row.sourceActorId,
			action: 'commented',
			entityType: 'object',
			entityId: row.objectId,
			data: {
				content: commentBody,
				metadata: {
					notification_id: row.id,
					default_action: defaultAction,
					expired: true,
				},
			},
		})
	}

	private resetLoop(state: LoopState, name: string): void {
		if (state.failures > 0) {
			logger.info(`${name} recovered after ${state.failures} consecutive failures`)
		}
		state.failures = 0
		state.backoffUntil = null
	}

	private recordLoopFailure(state: LoopState, name: string, err: unknown): void {
		state.failures += 1
		const backoffMs = calculateBackoffMs(state.failures)
		state.backoffUntil = new Date(Date.now() + backoffMs)
		const message = err instanceof Error ? err.message : String(err)
		if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
			logger.error(`${name} circuit breaker open — ${state.failures} consecutive failures`, {
				error: message,
				backoffUntil: state.backoffUntil.toISOString(),
			})
		} else {
			logger.warn(`${name} tick failed (${state.failures})`, {
				error: message,
				backoffUntil: state.backoffUntil.toISOString(),
			})
		}
	}
}

// Look up the label for the selected default option, if the notification
// metadata carries an `options` array. Falls back to the raw action key so
// the comment still names *something* useful.
function resolveOptionLabel(metadata: unknown, defaultAction: string | null): string | null {
	if (!defaultAction) return null
	if (!metadata || typeof metadata !== 'object') return null
	const options = (metadata as { options?: unknown }).options
	if (!Array.isArray(options)) return null
	for (const opt of options) {
		if (opt && typeof opt === 'object') {
			const record = opt as Record<string, unknown>
			if (record.value === defaultAction || record.key === defaultAction) {
				if (typeof record.label === 'string') return record.label
			}
		}
	}
	return null
}
