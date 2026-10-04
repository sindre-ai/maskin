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
	it('aborts the transaction when the reconciler deleted the claim mid-processing', async () => {
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

	it('aborts the transaction when another writer already processed the claim', async () => {
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

	it('marks additional claims processed in the same transaction, and rolls back if one is gone', async () => {
		const action = `linkedin.multi.${randomUUID()}`
		const claims = await db
			.insert(webhookDeliveries)
			.values([
				{ provider: 'linkedin-unipile', externalId: 'evt:acc:1', workspaceId },
				{ provider: 'linkedin-unipile', externalId: 'msg:acc:1', workspaceId },
			])
			.returning({ id: webhookDeliveries.id })
		const [first, second] = claims
		if (!first || !second) throw new Error('claims not inserted')
		const row = {
			workspaceId,
			actorId,
			action,
			entityType: 'integration',
			entityId: workspaceId,
			data: { ref: 'multi' },
		}

		// Second claim gone: the whole transaction aborts, including the first claim's update.
		await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, second.id))
		await expect(
			commitWebhookDelivery(db, {
				eventRows: [row],
				claimRowId: first.id,
				additionalClaimRowIds: [second.id],
			}),
		).rejects.toBeInstanceOf(ClaimReleasedError)
		const [stillOpen] = await db
			.select({ processedAt: webhookDeliveries.processedAt })
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.id, first.id))
		expect(stillOpen?.processedAt).toBeNull()

		// Both claims present: events land and both claims are marked processed together.
		const [replacement] = await db
			.insert(webhookDeliveries)
			.values({ provider: 'linkedin-unipile', externalId: 'msg:acc:2', workspaceId })
			.returning({ id: webhookDeliveries.id })
		if (!replacement) throw new Error('claim not inserted')
		await commitWebhookDelivery(db, {
			eventRows: [row],
			claimRowId: first.id,
			additionalClaimRowIds: [replacement.id],
		})
		const processed = await db
			.select({ processedAt: webhookDeliveries.processedAt })
			.from(webhookDeliveries)
			.where(eq(webhookDeliveries.workspaceId, workspaceId))
		expect(processed).toHaveLength(2)
		expect(processed.every((c) => c.processedAt !== null)).toBe(true)
		const landed = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, action)))
		expect(landed).toHaveLength(1)
	})
})
