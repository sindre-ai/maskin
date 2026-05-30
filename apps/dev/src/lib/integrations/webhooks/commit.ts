import type { Database } from '@maskin/db'
import { events, webhookDeliveries } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'

export type WebhookEventRow = typeof events.$inferInsert

/**
 * Thrown when the gated UPDATE on `webhook_deliveries.processed_at` matches 0
 * rows — i.e. the reconciler released the claim while the route's fan-out was
 * still in flight. The transaction is aborted by the throw so the events
 * insert never commits.
 */
export class ClaimReleasedError extends Error {
	constructor(public readonly claimRowId: string) {
		super(`webhook_deliveries claim ${claimRowId} was released before processing committed`)
		this.name = 'ClaimReleasedError'
	}
}

/**
 * Commits the downstream events for a webhook delivery and marks the matching
 * `webhook_deliveries` claim processed in a single transaction. Gates the
 * events insert on the claim still existing and being unprocessed: if the
 * reconciler released the claim between when the route claimed it and when
 * fan-out finished, the UPDATE matches zero rows, we throw, and the
 * transaction rolls back so we never leave an `events` row dangling without
 * its provenance claim.
 *
 * Pass `claimRowId: null` only when no claim was taken (e.g. the provider
 * didn't supply a delivery id, or the dedup-table claim insert failed and we
 * fell through fail-open) — in that case there is no claim to gate on.
 */
export async function commitWebhookDelivery(
	db: Database,
	args: {
		eventRows: WebhookEventRow[]
		claimRowId: string | null
	},
): Promise<void> {
	await db.transaction(async (tx) => {
		if (args.eventRows.length > 0) {
			await tx.insert(events).values(args.eventRows)
		}
		if (args.claimRowId) {
			const matched = await tx
				.update(webhookDeliveries)
				.set({ processedAt: new Date() })
				.where(
					and(eq(webhookDeliveries.id, args.claimRowId), isNull(webhookDeliveries.processedAt)),
				)
				.returning({ id: webhookDeliveries.id })
			if (matched.length === 0) {
				throw new ClaimReleasedError(args.claimRowId)
			}
		}
	})
}
