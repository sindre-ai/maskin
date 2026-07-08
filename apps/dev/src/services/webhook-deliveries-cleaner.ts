import type { Database } from '@maskin/db'
import { webhookDeliveries } from '@maskin/db/schema'
import { lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 6 * 60 * 60 * 1000 // 6h
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30d

/**
 * Background loop that trims old rows from `webhook_deliveries`. The table is
 * an idempotency ledger — once a delivery is older than any provider's retry
 * window, the row no longer serves dedup and just consumes storage. Slack's
 * documented retry window is ~1h; the GitHub deployment-status attribution
 * (`bet/deploy-event`) needs a 30-day dedup window so a delayed redelivery of
 * a production deploy is still recognised as a duplicate. 30 days covers both
 * without adding a second ledger.
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
