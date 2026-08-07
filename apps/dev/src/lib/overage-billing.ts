import type { Database } from '@maskin/db'
import { events, workspaceOverageUsage } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { OVERAGE_BLOCK_PRICE_USD, OVERAGE_BLOCK_TOKENS } from './billing-defaults'
import { getWorkspacePlanCap, getWorkspacePlanTokenUsage } from './llm-routing'
import { logger } from './logger'
import { getStripeClient, readStripeEnv, reportOverageBlock } from './stripe'
import type { WorkspaceSettings } from './types'

/**
 * Checks whether a session's completion pushed the workspace's cumulative
 * maskin_plan overage past one or more new `OVERAGE_BLOCK_TOKENS` boundaries,
 * and if so, claims + reports each newly-crossed block to Stripe as a meter
 * event. No-op for trial, byollm, or any workspace without
 * `billing.overage_enabled` — those either can't go over cap (hard-blocked by
 * `checkPlanCap`) or aren't set up for metered billing.
 *
 * Reporting only ever runs after a session has already completed, so a
 * Stripe outage here can never block product usage — failures are logged and
 * left for the overage-usage reconciler to retry (`reportedAt` stays NULL).
 */
export async function recordOverageIfCrossed(params: {
	db: Database
	workspaceId: string
	sessionId: string
	actorId: string
	wsSettings: WorkspaceSettings
}): Promise<void> {
	const { db, workspaceId, sessionId, actorId, wsSettings } = params
	const billing = wsSettings.billing
	if (billing?.plan !== 'pro' && billing?.plan !== 'team') return
	if (billing?.overage_enabled !== true || billing?.status !== 'active') return
	if (!billing?.stripe_customer_id) return

	const cap = getWorkspacePlanCap(wsSettings)
	if (cap === null) return

	const periodStartSec = typeof billing.period_start === 'number' ? billing.period_start : 0
	const periodStartMs =
		typeof billing.period_start === 'number' ? billing.period_start * 1000 : undefined

	const used = await getWorkspacePlanTokenUsage(db, workspaceId, periodStartMs)
	const overageTokens = Math.max(0, used - cap)
	const highestBlockIndex = Math.floor(overageTokens / OVERAGE_BLOCK_TOKENS)
	if (highestBlockIndex < 1) return

	let stripe: ReturnType<typeof getStripeClient>
	try {
		stripe = getStripeClient(readStripeEnv())
	} catch (err) {
		logger.warn('Overage billing: Stripe not configured, skipping report', {
			workspaceId,
			sessionId,
			error: String(err),
		})
		return
	}

	for (let blockIndex = 1; blockIndex <= highestBlockIndex; blockIndex++) {
		const claimed = await db
			.insert(workspaceOverageUsage)
			.values({
				workspaceId,
				periodStart: periodStartSec,
				blockIndex,
				tokensAtBlock: Math.min(overageTokens, blockIndex * OVERAGE_BLOCK_TOKENS),
				sessionId,
			})
			.onConflictDoNothing({
				target: [
					workspaceOverageUsage.workspaceId,
					workspaceOverageUsage.periodStart,
					workspaceOverageUsage.blockIndex,
				],
			})
			.returning({ id: workspaceOverageUsage.id })

		// 0 rows back means another completion (or the reconciler) already
		// claimed this block — nothing left to do here.
		const claimId = claimed[0]?.id
		if (!claimId) continue

		try {
			const meterEvent = await reportOverageBlock(stripe, {
				customerId: billing.stripe_customer_id,
				blockIdempotencyKey: `${workspaceId}:${periodStartSec}:${blockIndex}`,
			})
			await db
				.update(workspaceOverageUsage)
				.set({ reportedAt: new Date(), stripeMeterEventId: meterEvent.identifier })
				.where(eq(workspaceOverageUsage.id, claimId))

			await db.insert(events).values({
				workspaceId,
				actorId,
				action: 'session_overage_block_charged',
				entityType: 'session',
				entityId: sessionId,
				data: {
					block_index: blockIndex,
					tokens_at_block: overageTokens,
					price_usd: OVERAGE_BLOCK_PRICE_USD,
				},
			})
		} catch (err) {
			// Claim row is left with reportedAt: NULL — the overage-usage
			// reconciler retries it with the same deterministic idempotency key.
			logger.warn('Failed to report overage block to Stripe; reconciler will retry', {
				workspaceId,
				sessionId,
				blockIndex,
				error: String(err),
			})
		}
	}
}
