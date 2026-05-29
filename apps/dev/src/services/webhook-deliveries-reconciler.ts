import type { Database } from '@maskin/db'
import { webhookDeliveries } from '@maskin/db/schema'
import { and, isNull, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'

const TICK_MS = 5 * 60 * 1000 // 5m
const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15m

/**
 * Releases `webhook_deliveries` claims whose downstream work never committed
 * (`processed_at IS NULL`) past the stale threshold. The route claims the
 * delivery before running fan-out so a Slack retry arriving mid-processing is
 * deduped; if the process restarts (deploy, OOM, kill -9) between the claim
 * and the events insert, the claim sticks and the next retry is silently
 * skipped — exactly the failure mode this loop heals.
 *
 * The threshold is the budget for the longest expected fan-out. Slack's
 * worst case is `MAX_FILES_PER_EVENT (20) × DOWNLOAD_TIMEOUT_MS (30s)` ≈ 10
 * minutes; 15m gives that headroom without sitting on top of Slack's ~1h
 * retry window for too long.
 */
export class WebhookDeliveriesReconciler {
	private timer: NodeJS.Timeout | null = null
	private running = false

	constructor(
		private db: Database,
		private staleThresholdMs: number = STALE_THRESHOLD_MS,
		private tickMs: number = TICK_MS,
	) {}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.tickMs)
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
			const cutoff = new Date(Date.now() - this.staleThresholdMs)
			const released = await this.db
				.delete(webhookDeliveries)
				.where(and(isNull(webhookDeliveries.processedAt), lt(webhookDeliveries.receivedAt, cutoff)))
				.returning({
					id: webhookDeliveries.id,
					provider: webhookDeliveries.provider,
					externalId: webhookDeliveries.externalId,
					workspaceId: webhookDeliveries.workspaceId,
				})
			if (released.length > 0) {
				logger.warn('Released orphaned webhook delivery claims', {
					count: released.length,
					cutoff: cutoff.toISOString(),
					providers: [...new Set(released.map((r) => r.provider))],
					sample: released.slice(0, 5).map((r) => ({
						provider: r.provider,
						externalId: r.externalId,
						workspaceId: r.workspaceId,
					})),
				})
			}
		} catch (err) {
			logger.error('Webhook deliveries reconciler tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
