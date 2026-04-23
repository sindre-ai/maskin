import { notifications } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: relationshipsRoutes } = await import('../../routes/relationships')

function createApp() {
	return createIntegrationApp(
		{ path: '/api/objects', module: objectsRoutes },
		{ path: '/api/relationships', module: relationshipsRoutes },
	)
}

/**
 * End-to-end coverage for the participation model introduced in the multiplayer PR:
 *
 *   object + assigned_to/watches edges → status change → notifications
 *
 * Uses the real DB (no mocks) so participant invariants hold: unique edge constraint,
 * notifyParticipants fan-out, and the mutator-exclusion rule.
 */
describe('Multiplayer Integration', () => {
	let workspaceId: string
	let objectId: string
	let mutator: string
	let assignee1: string
	let assignee2: string
	let watcher: string

	beforeEach(async () => {
		mutator = getTestActorId()
		const ws = await insertWorkspace(db, mutator)
		workspaceId = ws.id
		const obj = await insertObject(db, workspaceId, mutator, {
			type: 'task',
			status: 'todo',
			title: 'Ship the thing',
		})
		objectId = obj.id

		const a1 = await insertActor(db)
		const a2 = await insertActor(db)
		const w = await insertActor(db)
		assignee1 = a1.id
		assignee2 = a2.id
		watcher = w.id
	})

	it('status change fans out notifications to assignees + watchers minus the mutator', async () => {
		const app = createApp()

		// Attach two assignees + one watcher via the public API (creating real
		// `assigned_to` / `watches` edges).
		for (const actorId of [assignee1, assignee2]) {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'object',
						source_id: objectId,
						target_type: 'actor',
						target_id: actorId,
						type: 'assigned_to',
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
		}
		const watchRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'object',
					source_id: objectId,
					target_type: 'actor',
					target_id: watcher,
					type: 'watches',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(watchRes.status).toBe(201)

		// Mutator also assigns themselves — should NOT receive a notification on their
		// own status change.
		const selfRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'object',
					source_id: objectId,
					target_type: 'actor',
					target_id: mutator,
					type: 'assigned_to',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(selfRes.status).toBe(201)

		// Drive the status change through the PATCH route so notifyParticipants fires.
		const patchRes = await app.request(
			jsonRequest('PATCH', `/api/objects/${objectId}`, { status: 'in_progress' }),
		)
		expect(patchRes.status).toBe(200)
		const body = await patchRes.json()
		expect(body.status).toBe('in_progress')
		expect(body.assignees.sort()).toEqual([assignee1, assignee2, mutator].sort())
		expect(body.watchers).toEqual([watcher])

		// Exactly three notifications: one per non-mutator participant.
		const notifs = await db
			.select()
			.from(notifications)
			.where(and(eq(notifications.objectId, objectId), eq(notifications.type, 'alert')))
		expect(notifs).toHaveLength(3)
		const targets = notifs.map((n) => n.targetActorId).sort()
		expect(targets).toEqual([assignee1, assignee2, watcher].sort())
		// Mutator NEVER receives a notification.
		expect(targets).not.toContain(mutator)
		// Title carries the status transition.
		for (const n of notifs) {
			expect(n.title).toContain('Ship the thing')
			expect(n.content).toContain('"todo"')
			expect(n.content).toContain('"in_progress"')
			expect(n.sourceActorId).toBe(mutator)
		}
	})

	it('reuses the same participant when they are both assignee and watcher — no duplicate notifications', async () => {
		const app = createApp()

		// Same actor has BOTH edges.
		for (const type of ['assigned_to', 'watches']) {
			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					{
						source_type: 'object',
						source_id: objectId,
						target_type: 'actor',
						target_id: assignee1,
						type,
					},
					{ 'x-workspace-id': workspaceId },
				),
			)
			expect(res.status).toBe(201)
		}

		const patchRes = await app.request(
			jsonRequest('PATCH', `/api/objects/${objectId}`, { status: 'in_progress' }),
		)
		expect(patchRes.status).toBe(200)

		const notifs = await db.select().from(notifications).where(eq(notifications.objectId, objectId))
		expect(notifs).toHaveLength(1)
		expect(notifs[0]?.targetActorId).toBe(assignee1)
	})

	it('rejects participant edges with the wrong source/target types', async () => {
		const app = createApp()

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'actor', // wrong — assigned_to must be object→actor
					source_id: mutator,
					target_type: 'actor',
					target_id: assignee1,
					type: 'assigned_to',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(400)
	})
})
