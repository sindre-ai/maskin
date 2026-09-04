import type { Database } from '@maskin/db'
import { idempotencyRecords } from '@maskin/db/schema'
import { Cron } from 'croner'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Sliding-TTL cleaner for `idempotency_records`. The ledger de-duplicates
 * agent side-effects across snapshot restore + tool re-issue (see the schema
 * comment on `idempotencyRecords`). Once a row is older than any caller's
 * realistic retry window, it no longer serves dedup and just consumes
 * storage — 7 days is comfortably wider than any first-party client's
 * retry policy and matches the spec §3 sizing (~140k rows steady-state
 * at 200 accounts × 100 sends/day).
 *
 * Mirrors the shape of WebhookDeliveriesCleaner (see
 * apps/dev/src/services/webhook-deliveries-cleaner.ts): a swallowed-error
 * tick that logs but never throws, guarded against overlapping runs.
 * Difference: this one is triggered by a cron expression (nightly at 03:17
 * UTC — off the round hour so it doesn't pile up with other cron-driven
 * maintenance) rather than a raw setInterval, because the task spec
 * explicitly calls for a croner job.
 */
const CRON_EXPRESSION = '17 3 * * *'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export class PurgeIdempotencyJob {
	private job: Cron | null = null
	private running = false

	constructor(
		private db: Database,
		private retentionMs: number = RETENTION_MS,
		private cronExpression: string = CRON_EXPRESSION,
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
			const cutoff = new Date(Date.now() - this.retentionMs)
			const deleted = await this.db
				.delete(idempotencyRecords)
				.where(lt(idempotencyRecords.createdAt, cutoff))
				.returning({ key: idempotencyRecords.key })
			if (deleted.length > 0) {
				logger.info('Purge idempotency records tick', {
					deleted: deleted.length,
					cutoff: cutoff.toISOString(),
				})
			}
		} catch (err) {
			logger.error('Purge idempotency records tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
