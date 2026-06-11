import type { Database } from '@maskin/db'
import { webhookDeliveries } from '@maskin/db/schema'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 6 * 60 * 60 * 1000 // 6h
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000 // 14d

/**
 * Background loop that trims old rows from `webhook_deliveries`. The table is
 * an idempotency ledger — once a delivery is older than any provider's retry
 * window, the row no longer serves dedup and just consumes storage. Slack's
 * documented retry window is ~1h; 14 days is a wide safety margin across
 * providers without keeping the ledger forever.
 */
export class WebhookDeliveriesCleaner {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private retentionMs: number = RETENTION_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), TICK_MS)
		setTimeout(() => this.tick(), 60_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const cutoff = new Date(Date.now() - this.retentionMs)
			const deleted = await this.db
				.delete(webhookDeliveries)
				.where(lt(webhookDeliveries.receivedAt, cutoff))
				.returning({ id: webhookDeliveries.id })
			if (deleted.length > 0) {
				logger.info('Webhook deliveries cleaner tick', {
					deleted: deleted.length,
					cutoff: cutoff.toISOString(),
				})
			}
		} catch (err) {
			logger.error('Webhook deliveries cleaner tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
