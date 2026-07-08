import { randomUUID } from 'node:crypto'
import { webhookDeliveries } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Backs the T2 idempotency DoD: a redelivered `X-GitHub-Delivery` UUID is
 * silently dropped by the shared `webhook_deliveries` ledger. The webhook
 * route claims the delivery via
 *   INSERT ... ON CONFLICT (provider, external_id, workspace_id) DO NOTHING
 * so a second insert for the same tuple returns zero rows and the receiver
 * short-circuits with `skipped: 'duplicate'` — no re-attribution, no metadata
 * write. This test exercises that constraint against real Postgres because
 * the mocked-DB unit tests can't catch conflict semantics.
 */
describe('GitHub deployment_status idempotency (webhook_deliveries)', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await sql`TRUNCATE webhook_deliveries`
	})

	it('inserts the first delivery and rejects the redelivered UUID for the same workspace', async () => {
		const deliveryId = randomUUID()

		const first = await db
			.insert(webhookDeliveries)
			.values({ provider: 'github', externalId: deliveryId, workspaceId })
			.onConflictDoNothing({
				target: [
					webhookDeliveries.provider,
					webhookDeliveries.externalId,
					webhookDeliveries.workspaceId,
				],
			})
			.returning({ id: webhookDeliveries.id })
		expect(first).toHaveLength(1)

		const redelivery = await db
			.insert(webhookDeliveries)
			.values({ provider: 'github', externalId: deliveryId, workspaceId })
			.onConflictDoNothing({
				target: [
					webhookDeliveries.provider,
					webhookDeliveries.externalId,
					webhookDeliveries.workspaceId,
				],
			})
			.returning({ id: webhookDeliveries.id })
		// Zero-row return is the signal the receiver reads to short-circuit with
		// `skipped: 'duplicate'` without running attribution or a metadata write.
		expect(redelivery).toHaveLength(0)

		const rows = await db
			.select()
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.provider, 'github'),
					eq(webhookDeliveries.externalId, deliveryId),
					eq(webhookDeliveries.workspaceId, workspaceId),
				),
			)
		expect(rows).toHaveLength(1)
	})

	// The GitHub App can be installed once but connected to multiple Maskin
	// workspaces. The same X-GitHub-Delivery UUID arriving for two workspaces is
	// two independent processing runs — attribution needs to see it in both.
	// The unique key is scoped by workspace_id for exactly this reason.
	it('allows the same delivery UUID to be claimed independently per workspace', async () => {
		const deliveryId = randomUUID()
		const otherWs = await insertWorkspace(db, getTestActorId())

		const first = await db
			.insert(webhookDeliveries)
			.values({ provider: 'github', externalId: deliveryId, workspaceId })
			.onConflictDoNothing()
			.returning({ id: webhookDeliveries.id })
		const second = await db
			.insert(webhookDeliveries)
			.values({ provider: 'github', externalId: deliveryId, workspaceId: otherWs.id })
			.onConflictDoNothing()
			.returning({ id: webhookDeliveries.id })

		expect(first).toHaveLength(1)
		expect(second).toHaveLength(1)
	})

	// A `deployment_status` claim and a same-day `pull_request.synchronize`
	// claim for the same delivery UUID (theoretically impossible from GitHub,
	// but a sanity check on the constraint scope) would share the same
	// `(provider, external_id, workspace_id)` tuple. The uniqueness is by tuple,
	// not by event type — the receiver relies on the delivery ID already being
	// event-scoped by GitHub.
	it('the uniqueness key does not include event type', async () => {
		const deliveryId = randomUUID()

		await db
			.insert(webhookDeliveries)
			.values({ provider: 'github', externalId: deliveryId, workspaceId })
			.returning({ id: webhookDeliveries.id })

		const dup = await db
			.insert(webhookDeliveries)
			.values({ provider: 'github', externalId: deliveryId, workspaceId })
			.onConflictDoNothing({
				target: [
					webhookDeliveries.provider,
					webhookDeliveries.externalId,
					webhookDeliveries.workspaceId,
				],
			})
			.returning({ id: webhookDeliveries.id })

		expect(dup).toHaveLength(0)
	})
})
