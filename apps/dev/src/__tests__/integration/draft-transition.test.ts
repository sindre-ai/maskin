import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, workspaceMembers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { draftTaskStateToMetadata } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const { default: objectsRoutes } = await import('../../routes/objects')

function appAs(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/objects', objectsRoutes)
	return app
}

function transition(id: string, body: Record<string, unknown>) {
	return jsonRequest('POST', `/api/objects/${id}/draft`, body)
}

/**
 * POST /objects/:id/draft — how the draft card edits, approves, undoes and
 * restores. Against real Postgres because the guarantee is a row lock: a stale
 * card must not be able to write over a state it did not see.
 */
describe('POST /objects/:id/draft', () => {
	let workspaceId: string
	let ownerId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
	})

	async function draftTask(state: 'draft' | 'approved' = 'draft', content = 'Hi Mette') {
		const task = await insertObject(db, workspaceId, ownerId, {
			type: 'task',
			content,
			metadata: {
				unrelated: 'kept',
				...draftTaskStateToMetadata({
					state,
					subject: 'Following up',
					original_subject: 'Following up',
					original_body: 'Hi',
				}),
			},
		})
		if (!task) throw new Error('failed to seed task')
		return task
	}

	async function reload(id: string) {
		const [row] = await db.select().from(objects).where(eq(objects.id, id))
		if (!row) throw new Error('task vanished')
		return row
	}

	it('saves an edit and leaves every other metadata key alone', async () => {
		const task = await draftTask()

		const res = await appAs(ownerId).request(
			transition(task.id, { action: 'edit', expected_state: 'draft', body: 'Shorter.' }),
		)

		expect(res.status).toBe(200)
		const row = await reload(task.id)
		expect(row.content).toBe('Shorter.')
		expect(row.metadata).toMatchObject({ unrelated: 'kept', draft_state: 'draft' })
	})

	it('approves with the text it is sent and stamps the approval time', async () => {
		const task = await draftTask()

		const res = await appAs(ownerId).request(
			transition(task.id, { action: 'approve', expected_state: 'draft', body: 'Final text.' }),
		)

		expect(res.status).toBe(200)
		const row = await reload(task.id)
		expect(row.content).toBe('Final text.')
		expect(row.metadata).toMatchObject({ draft_state: 'approved' })
		expect((row.metadata as Record<string, unknown>).draft_approved_at).toEqual(expect.any(String))
	})

	it('answers 409 and leaves the text alone when a stale tab edits an approved draft', async () => {
		const task = await draftTask('approved', 'Approved text')

		const res = await appAs(ownerId).request(
			transition(task.id, { action: 'edit', expected_state: 'draft', body: 'Sneaked in.' }),
		)

		expect(res.status).toBe(409)
		expect((await reload(task.id)).content).toBe('Approved text')
	})

	it('lets exactly one of two concurrent approvals through', async () => {
		const task = await draftTask()
		const app = appAs(ownerId)
		const approve = () =>
			app.request(transition(task.id, { action: 'approve', expected_state: 'draft', body: 'Go.' }))

		const statuses = (await Promise.all([approve(), approve()])).map((res) => res.status).sort()

		// The loser sees the winner's approval, so its card never messages the agent.
		expect(statuses).toEqual([200, 409])
	})

	it('undoes an approval and clears the approval time', async () => {
		const task = await draftTask('approved')

		const res = await appAs(ownerId).request(
			transition(task.id, { action: 'undo', expected_state: 'approved' }),
		)

		expect(res.status).toBe(200)
		expect((await reload(task.id)).metadata).toMatchObject({
			draft_state: 'draft',
			draft_approved_at: null,
		})
	})

	it('restores the original text', async () => {
		const task = await draftTask('draft', 'Edited')

		await appAs(ownerId).request(
			transition(task.id, { action: 'restore', expected_state: 'draft' }),
		)

		expect((await reload(task.id)).content).toBe('Hi')
	})

	it('answers 400 when there is no text to approve', async () => {
		const task = await draftTask()

		const res = await appAs(ownerId).request(
			transition(task.id, { action: 'approve', expected_state: 'draft', body: '  ' }),
		)

		expect(res.status).toBe(400)
		expect((await reload(task.id)).metadata).toMatchObject({ draft_state: 'draft' })
	})

	it('answers 400 for a task that is not a draft', async () => {
		const task = await insertObject(db, workspaceId, ownerId, { type: 'task' })
		if (!task) throw new Error('failed to seed task')

		const res = await appAs(ownerId).request(
			transition(task.id, { action: 'edit', expected_state: 'draft', body: 'x' }),
		)

		expect(res.status).toBe(400)
	})

	it('logs an updated event for the change', async () => {
		const task = await draftTask()

		await appAs(ownerId).request(
			transition(task.id, { action: 'edit', expected_state: 'draft', body: 'Shorter.' }),
		)

		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, task.id), eq(events.action, 'updated')))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({ draft_action: 'edit' })
	})

	it('answers 404 to someone outside the workspace, and changes nothing', async () => {
		const task = await draftTask()
		const outsider = await insertActor(db, { type: 'human' })
		if (!outsider) throw new Error('failed to seed actor')

		const res = await appAs(outsider.id).request(
			transition(task.id, { action: 'edit', expected_state: 'draft', body: 'Nope.' }),
		)

		expect(res.status).toBe(404)
		expect((await reload(task.id)).content).toBe('Hi Mette')
	})

	it('refuses a viewer, who cannot edit', async () => {
		const task = await draftTask()
		const viewer = await insertActor(db, { type: 'human' })
		if (!viewer) throw new Error('failed to seed actor')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		const res = await appAs(viewer.id).request(
			transition(task.id, { action: 'edit', expected_state: 'draft', body: 'Nope.' }),
		)

		// The viewer guard throws and the app's error handler maps it; this app has
		// none, so what matters here is that the request did not succeed.
		expect(res.status).not.toBe(200)
		expect((await reload(task.id)).content).toBe('Hi Mette')
	})

	it('answers 404 for an unknown object', async () => {
		const res = await appAs(ownerId).request(
			transition('00000000-0000-4000-8000-000000000000', {
				action: 'edit',
				expected_state: 'draft',
				body: 'x',
			}),
		)

		expect(res.status).toBe(404)
	})
})
