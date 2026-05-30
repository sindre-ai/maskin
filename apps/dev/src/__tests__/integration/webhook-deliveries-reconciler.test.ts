import { webhookDeliveries } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { WebhookDeliveriesReconciler } from '../../services/webhook-deliveries-reconciler'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

describe('WebhookDeliveriesReconciler Integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await sql`TRUNCATE webhook_deliveries`
	})

	/**
	 * Simulates the failure mode the reconciler exists to heal: the webhook
	 * route committed the dedup claim, started fan-out, and the process died
	 * before the events insert (and therefore `processed_at`) committed. The
	 * orphan must be released so the provider's next retry can reprocess the
	 * delivery — otherwise the claim row dedups every retry and the event is
	 * silently dropped.
	 */
	it('releases stale unprocessed claims and lets a retry reclaim them', async () => {
		const externalId = 'Ev08RESTARTMIDFANOUT'
		const stale = new Date(Date.now() - 30 * 60 * 1000) // 30m ago

		await sql`
			INSERT INTO webhook_deliveries (provider, external_id, workspace_id, received_at, processed_at)
			VALUES ('slack', ${externalId}, ${workspaceId}, ${stale.toISOString()}, NULL)
		`

		const reconciler = new WebhookDeliveriesReconciler(db, 15 * 60 * 1000)
		await reconciler.tick()

		const remaining = await db
			.select()
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.provider, 'slack'),
					eq(webhookDeliveries.externalId, externalId),
					eq(webhookDeliveries.workspaceId, workspaceId),
				),
			)
		expect(remaining).toHaveLength(0)

		// The retry is now free to land — the unique constraint is gone with
		// the claim row, so the insert succeeds rather than being short-circuited.
		const reclaimed = await db
			.insert(webhookDeliveries)
			.values({ provider: 'slack', externalId, workspaceId })
			.onConflictDoNothing({
				target: [
					webhookDeliveries.provider,
					webhookDeliveries.externalId,
					webhookDeliveries.workspaceId,
				],
			})
			.returning({ id: webhookDeliveries.id })
		expect(reclaimed).toHaveLength(1)
	})

	it('leaves completed claims alone even when they are old', async () => {
		const externalId = 'Ev08COMPLETED'
		const stale = new Date(Date.now() - 30 * 60 * 1000)
		const processedAt = new Date(Date.now() - 29 * 60 * 1000)

		await sql`
			INSERT INTO webhook_deliveries (provider, external_id, workspace_id, received_at, processed_at)
			VALUES ('slack', ${externalId}, ${workspaceId}, ${stale.toISOString()}, ${processedAt.toISOString()})
		`

		const reconciler = new WebhookDeliveriesReconciler(db, 15 * 60 * 1000)
		await reconciler.tick()

		const remaining = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.externalId, externalId))
		expect(remaining).toHaveLength(1)
		expect(remaining[0]?.processedAt).not.toBeNull()
	})

	it('leaves fresh unprocessed claims alone — fan-out may still be running', async () => {
		const externalId = 'Ev08INFLIGHT'
		const fresh = new Date(Date.now() - 30 * 1000) // 30s ago

		await sql`
			INSERT INTO webhook_deliveries (provider, external_id, workspace_id, received_at, processed_at)
			VALUES ('slack', ${externalId}, ${workspaceId}, ${fresh.toISOString()}, NULL)
		`

		const reconciler = new WebhookDeliveriesReconciler(db, 15 * 60 * 1000)
		await reconciler.tick()

		const remaining = await db
			.select()
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.externalId, externalId))
		expect(remaining).toHaveLength(1)
	})
})
