import type { Database } from '@maskin/db'
import type { AwaitingViesRow } from '@maskin/db/schema'
import { Cron } from 'croner'
import { trackViesReminderSent } from '../lib/analytics/vies-events'
import { findOlderThan, findRemindable, markReminderSent } from '../lib/awaiting-vies'
import { logger } from '../lib/logger'
import { getStripeClient } from '../lib/stripe'
import { voidAwaitingRow } from '../lib/vat-webhook'
import { sendAwaitingViesReminderEmail } from '../lib/vies-emails'

/**
 * The VIES scheduling primitive Architect flagged in the bet spec — a
 * single 15-minute cron running two sweeps per pass:
 *
 *   1. `sweepReminders` — T+2h, sends the "still verifying" reminder on
 *      each `awaiting_vies` row and stamps `reminder_sent_at` under a
 *      `SELECT ... FOR UPDATE` lock (see `awaiting-vies.ts:markReminderSent`
 *      for the race handling).
 *   2. `sweepTimeouts` — T+24h, refunds and deletes each row via
 *      `voidAwaitingRow(db, row, 'timeout', stripe)` — the shared void path
 *      in `lib/vat-webhook.ts` that the `customer.tax_id.updated` unverified
 *      branch also uses.
 *
 * Choice of primitive (spec's "day 1" pick): (a) new job under
 * `apps/dev/src/jobs/` using `croner`, registered from `apps/dev` boot.
 * Not (b) piggybacking on `services/trigger-runner.ts` — trigger-runner is
 * the user-authored automation surface (workspace triggers, cron triggers
 * users configure through the UI), and adding a built-in trigger type
 * would couple a Maskin-internal billing sweep to a workspace-triggered
 * substrate. The coupling risk (a workspace-authored trigger accidentally
 * changing the shape of the built-in sweep, or vice versa) is a
 * maskin-app-boundary concern the spec explicitly flagged. Path (a) sits
 * next to `purge-idempotency.ts`, the established shape for a scheduled
 * built-in maintenance job.
 *
 * Both sweeps early-return without touching the DB when no rows are
 * eligible, so leaving the job registered is a no-op until the webhook
 * starts writing rows to the `awaiting_vies` table.
 *
 * Guarded against overlapping runs — a slow tick will not double up with
 * the next one. Failures on a single row do not stop the sweep; other
 * rows continue.
 */
const CRON_EXPRESSION = '*/15 * * * *'
const REMINDER_AGE_MS = 2 * 60 * 60 * 1000
const TIMEOUT_AGE_MS = 24 * 60 * 60 * 1000

export class ViesSchedulerJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private cronExpression: string = CRON_EXPRESSION,
		private reminderAgeMs: number = REMINDER_AGE_MS,
		private timeoutAgeMs: number = TIMEOUT_AGE_MS,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			await processViesScheduler(this.db, {
				reminderAgeMs: this.reminderAgeMs,
				timeoutAgeMs: this.timeoutAgeMs,
			})
		} finally {
			this.running = false
		}
	}
}

export interface ProcessViesSchedulerDeps {
	reminderAgeMs: number
	timeoutAgeMs: number
	/** Injectable clock for tests. Defaults to `Date.now`. */
	now?: () => Date
}

/**
 * One tick of the scheduler. Exposed for the integration tests so they can
 * drive `sweepReminders` and `sweepTimeouts` end-to-end without booting a
 * cron. The sweeps run in order — reminders first (so a row that ages past
 * T+24h between two ticks still gets its reminder before the timeout
 * refund, if it hadn't already) — but the sweeps are independent and one
 * throwing does not stop the other.
 */
export async function processViesScheduler(
	db: Database,
	deps: ProcessViesSchedulerDeps,
): Promise<void> {
	const now = deps.now ?? (() => new Date())

	try {
		await sweepReminders(db, now(), deps.reminderAgeMs)
	} catch (err) {
		logger.error('VIES sweepReminders failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
	try {
		await sweepTimeouts(db, now(), deps.timeoutAgeMs)
	} catch (err) {
		logger.error('VIES sweepTimeouts failed', {
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

export async function sweepReminders(
	db: Database,
	nowDate: Date,
	reminderAgeMs: number,
): Promise<void> {
	const olderThan = new Date(nowDate.getTime() - reminderAgeMs)
	const rows = await findRemindable(db, olderThan)
	if (rows.length === 0) return

	let sent = 0
	let skipped = 0
	for (const row of rows) {
		try {
			const stamped = await markReminderSent(db, row.id)
			if (!stamped) {
				skipped++
				continue
			}
			await sendAwaitingViesReminderEmail(row)
			await trackViesReminderSent({
				customerId: row.customerId,
				sessionId: row.sessionId,
				minutesElapsed: minutesElapsed(row, nowDate),
			})
			sent++
		} catch (err) {
			logger.error('VIES reminder for row failed', {
				rowId: row.id,
				sessionId: row.sessionId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	logger.info('VIES sweepReminders tick', {
		candidates: rows.length,
		sent,
		skipped,
	})
}

export async function sweepTimeouts(
	db: Database,
	nowDate: Date,
	timeoutAgeMs: number,
): Promise<void> {
	const cutoff = new Date(nowDate.getTime() - timeoutAgeMs)
	const rows = await findOlderThan(db, cutoff)
	if (rows.length === 0) return

	const stripe = getStripeClient()
	let voided = 0
	for (const row of rows) {
		try {
			await voidAwaitingRow(db, row, 'timeout', stripe)
			voided++
		} catch (err) {
			logger.error('VIES timeout void for row failed', {
				rowId: row.id,
				sessionId: row.sessionId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	logger.info('VIES sweepTimeouts tick', {
		candidates: rows.length,
		voided,
	})
}

function minutesElapsed(row: AwaitingViesRow, nowDate: Date): number {
	const ms = nowDate.getTime() - row.createdAt.getTime()
	return Math.max(0, Math.floor(ms / 60_000))
}
