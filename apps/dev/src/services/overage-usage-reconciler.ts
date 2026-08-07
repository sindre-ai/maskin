import type { Database } from '@maskin/db'
import { workspaceOverageUsage, workspaces } from '@maskin/db/schema'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { getStripeClient, readStripeEnv, reportOverageBlock } from '../lib/stripe'
import type { WorkspaceSettings } from '../lib/types'

const TICK_MS = 5 * 60 * 1000 // 5m
const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15m

/**
 * Retries `workspace_overage_usage` claims whose Stripe report never
 * confirmed (`reported_at IS NULL`) past the stale threshold — a crash or a
 * transient Stripe outage between the claim insert and the meter-event call
 * in `lib/overage-billing.ts#recordOverageIfCrossed`. Unlike
 * `WebhookDeliveriesReconciler` (which releases stale claims for an external
 * retrier — Stripe — to reprocess), there is no external retrier for a block
 * Maskin itself failed to report, so this reconciler actively re-attempts the
 * same deterministic idempotency key rather than just clearing the claim.
 */
export class OverageUsageReconciler {
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
			const stale = await this.db
				.select({
					id: workspaceOverageUsage.id,
					workspaceId: workspaceOverageUsage.workspaceId,
					periodStart: workspaceOverageUsage.periodStart,
					blockIndex: workspaceOverageUsage.blockIndex,
					settings: workspaces.settings,
				})
				.from(workspaceOverageUsage)
				.innerJoin(workspaces, eq(workspaces.id, workspaceOverageUsage.workspaceId))
				.where(
					and(
						isNull(workspaceOverageUsage.reportedAt),
						lt(workspaceOverageUsage.createdAt, cutoff),
					),
				)

			if (stale.length === 0) return

			let stripe: ReturnType<typeof getStripeClient>
			try {
				stripe = getStripeClient(readStripeEnv())
			} catch (err) {
				logger.error('Overage usage reconciler: Stripe not configured', { error: String(err) })
				return
			}

			let retried = 0
			for (const row of stale) {
				const billing = (row.settings as WorkspaceSettings | null)?.billing
				const customerId = billing?.stripe_customer_id
				if (!customerId) {
					logger.warn('Overage usage reconciler: no stripe_customer_id on workspace, skipping', {
						id: row.id,
						workspaceId: row.workspaceId,
					})
					continue
				}
				try {
					const meterEvent = await reportOverageBlock(stripe, {
						customerId,
						blockIdempotencyKey: `${row.workspaceId}:${row.periodStart}:${row.blockIndex}`,
					})
					await this.db
						.update(workspaceOverageUsage)
						.set({ reportedAt: new Date(), stripeMeterEventId: meterEvent.identifier })
						.where(eq(workspaceOverageUsage.id, row.id))
					retried++
				} catch (err) {
					logger.error('Overage usage reconciler: retry failed, will retry again next tick', {
						id: row.id,
						workspaceId: row.workspaceId,
						blockIndex: row.blockIndex,
						error: String(err),
					})
				}
			}

			if (retried > 0) {
				logger.info('Overage usage reconciler retried stale claims', {
					count: retried,
					checked: stale.length,
				})
			}
		} catch (err) {
			logger.error('Overage usage reconciler tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
		}
	}
}
