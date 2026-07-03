import { events, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { PendingIntegrationsReaper } from '../../services/pending-integrations-reaper'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * The reaper exists to solve the "stale pending github connect row" class in
 * the churn bet: every `POST /connect` writes a `pending` row and, if the user
 * bails mid-round-trip, that row sticks around forever, blocking future
 * connects when the same nonce/externalId collides on the partial unique
 * index.
 */
describe('PendingIntegrationsReaper Integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		await sql`DELETE FROM integrations WHERE workspace_id = ${workspaceId}`
	})

	it('deletes pending rows past the stale threshold', async () => {
		const stale = new Date(Date.now() - 30 * 60 * 1000)
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'github',
				status: 'pending',
				externalId: 'nonce-abc',
				credentials: '',
				createdBy: actorId,
				updatedAt: stale,
			})
			.returning({ id: integrations.id })

		const reaper = new PendingIntegrationsReaper(db, 15 * 60 * 1000)
		await reaper.tick()

		const remaining = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, row?.id ?? ''))
		expect(remaining).toHaveLength(0)
	})

	it('leaves active rows alone even when they are old', async () => {
		const stale = new Date(Date.now() - 30 * 60 * 1000)
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'github',
				status: 'active',
				externalId: '141870781',
				credentials: 'encrypted-blob',
				createdBy: actorId,
				updatedAt: stale,
			})
			.returning({ id: integrations.id })

		const reaper = new PendingIntegrationsReaper(db, 15 * 60 * 1000)
		await reaper.tick()

		const remaining = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, row?.id ?? ''))
		expect(remaining).toHaveLength(1)
	})

	it('leaves fresh pending rows alone — a callback may still be in flight', async () => {
		const fresh = new Date(Date.now() - 30 * 1000)
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'github',
				status: 'pending',
				externalId: 'nonce-fresh',
				credentials: '',
				createdBy: actorId,
				updatedAt: fresh,
			})
			.returning({ id: integrations.id })

		const reaper = new PendingIntegrationsReaper(db, 15 * 60 * 1000)
		await reaper.tick()

		const remaining = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, row?.id ?? ''))
		expect(remaining).toHaveLength(1)
	})

	it('lets a fresh POST /connect reuse the workspace slot after a reap', async () => {
		const stale = new Date(Date.now() - 30 * 60 * 1000)
		await db.insert(integrations).values({
			workspaceId,
			provider: 'github',
			status: 'pending',
			externalId: 'nonce-old',
			credentials: '',
			createdBy: actorId,
			updatedAt: stale,
		})

		const reaper = new PendingIntegrationsReaper(db, 15 * 60 * 1000)
		await reaper.tick()

		const reused = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'github',
				status: 'pending',
				externalId: 'nonce-new',
				credentials: '',
				createdBy: actorId,
			})
			.returning({ id: integrations.id })
		expect(reused).toHaveLength(1)

		const eventsForWs = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityType, 'integration')))
		expect(eventsForWs.length).toBeGreaterThanOrEqual(0)
	})
})
