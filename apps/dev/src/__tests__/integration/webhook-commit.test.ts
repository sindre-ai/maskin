import { randomUUID } from 'node:crypto'
import { events, webhookDeliveries } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { ClaimReleasedError, commitWebhookDelivery } from '../../lib/integrations/webhooks/commit'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

describe('commitWebhookDelivery Integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		actorId = getTestActorId()
		await sql`TRUNCATE webhook_deliveries`
	})

	/**
	 * Regression: SHOULD #1 from PR #498 review. The reconciler can DELETE a
	 * stale claim while the route's fan-out is still running. The gated UPDATE
	 * matches 0 rows in that case; the helper must throw and roll back the
	 * events insert so we never leave an event row dangling without its claim.
	 */
	it('aborts the transaction when the claim was released before processing committed', async () => {
		const action = `slack.race.${randomUUID()}`

		const [claim] = await db
			.insert(webhookDeliveries)
			.values({ provider: 'slack', externalId: 'Ev08RACE', workspaceId })
			.returning({ id: webhookDeliveries.id })
		const claimRowId = claim?.id
		expect(claimRowId).toBeTruthy()
		if (!claimRowId) return

		// Simulate the reconciler tick deleting the orphan mid-fan-out.
		await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, claimRowId))

		await expect(
			commitWebhookDelivery(db, {
				eventRows: [
					{
						workspaceId,
						actorId,
						action,
						entityType: 'integration',
						entityId: workspaceId,
						data: { ref: 'race' },
					},
				],
				claimRowId,
			}),
		).rejects.toBeInstanceOf(ClaimReleasedError)

		const orphanEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, action)))
		expect(orphanEvents).toHaveLength(0)
	})

	it('commits events and marks the claim processed on the happy path', async () => {
		const action = `slack.happy.${randomUUID()}`

		const [claim] = await db
			.insert(webhookDeliveries)
			.values({ provider: 'slack', externalId: 'Ev08HAPPY', workspaceId })
			.returning({ id: webhookDeliveries.id })
		const claimRowId = claim?.id
		expect(claimRowId).toBeTruthy()
		if (!claimRowId) return

		await commitWebhookDelivery(db, {
			eventRows: [
				{
					workspaceId,
					actorId,
					action,
					entityType: 'integration',
					entityId: workspaceId,
					data: { ref: 'ok' },
				},
			],
			claimRowId,
		})

		const [updated] = await db
			.select({ processedAt: webhookDeliveries.processedAt })
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, claimRowId))
		expect(updated?.processedAt).not.toBeNull()

		const landed = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, action)))
		expect(landed).toHaveLength(1)
	})

	it('does not re-mark a claim that another writer already processed', async () => {
		const action = `slack.double.${randomUUID()}`

		const earlier = new Date(Date.now() - 60_000)
		const [claim] = await db
			.insert(webhookDeliveries)
			.values({
				provider: 'slack',
				externalId: 'Ev08DOUBLE',
				workspaceId,
				processedAt: earlier,
			})
			.returning({ id: webhookDeliveries.id })
		const claimRowId = claim?.id
		expect(claimRowId).toBeTruthy()
		if (!claimRowId) return

		await expect(
			commitWebhookDelivery(db, {
				eventRows: [
					{
						workspaceId,
						actorId,
						action,
						entityType: 'integration',
						entityId: workspaceId,
						data: { ref: 'double' },
					},
				],
				claimRowId,
			}),
		).rejects.toBeInstanceOf(ClaimReleasedError)

		const [row] = await db
			.select({ processedAt: webhookDeliveries.processedAt })
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, claimRowId))
		expect(row?.processedAt?.getTime()).toBe(earlier.getTime())
	})
})
