import { events, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { TokenManager } from '../../lib/integrations/oauth/token-manager'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const manager = new TokenManager()

describe('TokenManager.markRevoked', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function insertIntegration(status: 'active' | 'revoked' | 'pending') {
		const rows = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'google-calendar',
				status,
				credentials: '{}',
				createdBy: actorId,
			})
			.returning()
		return rows[0]
	}

	it('flips status to revoked and inserts a token_revoked audit event for an active integration', async () => {
		const integration = await insertIntegration('active')

		await manager.markRevoked(db, integration.id)

		const [updated] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, integration.id))
			.limit(1)
		expect(updated.status).toBe('revoked')

		const eventRows = await db.select().from(events).where(eq(events.entityId, integration.id))
		expect(eventRows).toHaveLength(1)
		const evt = eventRows[0]
		expect(evt.action).toBe('updated')
		expect(evt.entityType).toBe('integration')
		expect(evt.data).toMatchObject({ status: 'revoked', reason: 'token_revoked' })
		expect(evt.workspaceId).toBe(workspaceId)
		expect(evt.actorId).toBe(actorId)
	})

	it('is idempotent — second call on an already-revoked integration updates no rows and inserts no second event', async () => {
		const integration = await insertIntegration('active')

		await manager.markRevoked(db, integration.id)
		await manager.markRevoked(db, integration.id)

		const [updated] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, integration.id))
			.limit(1)
		expect(updated.status).toBe('revoked')

		// The WHERE status='active' guard prevents a second DB write — exactly one event row.
		const eventRows = await db.select().from(events).where(eq(events.entityId, integration.id))
		expect(eventRows).toHaveLength(1)
	})

	it('is a no-op for an integration already in revoked status — no event inserted', async () => {
		const integration = await insertIntegration('revoked')

		await manager.markRevoked(db, integration.id)

		const eventRows = await db.select().from(events).where(eq(events.entityId, integration.id))
		expect(eventRows).toHaveLength(0)
	})

	it('is a no-op for a non-existent integration id — resolves without throwing', async () => {
		await expect(
			manager.markRevoked(db, '00000000-0000-0000-0000-000000000000'),
		).resolves.toBeUndefined()
	})
})
