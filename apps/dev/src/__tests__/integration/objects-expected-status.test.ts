import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; notifyBridge: PgNotifyBridge }
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

describe('PATCH /api/objects/:id with expected_status', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		workspaceId = (await insertWorkspace(db, actorId)).id
	})

	it('moves the object when it is still in the status the caller saw', async () => {
		const bet = await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'opportunity' })

		const res = await appAs(actorId).request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, {
				status: 'proposed',
				expected_status: 'opportunity',
			}),
		)

		expect(res.status).toBe(200)
		const [row] = await db.select().from(objects).where(eq(objects.id, bet.id))
		expect(row.status).toBe('proposed')
	})

	it('answers 409 and changes nothing when the object has moved on since the caller saw it', async () => {
		const bet = await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active' })

		const res = await appAs(actorId).request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, {
				status: 'proposed',
				expected_status: 'opportunity',
			}),
		)

		expect(res.status).toBe(409)
		const [row] = await db.select().from(objects).where(eq(objects.id, bet.id))
		expect(row.status).toBe('active')
		const changes = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, bet.id), eq(events.action, 'status_changed')))
		expect(changes).toHaveLength(0)
	})

	it('behaves as before when expected_status is not sent', async () => {
		const bet = await insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active' })

		const res = await appAs(actorId).request(
			jsonRequest('PATCH', `/api/objects/${bet.id}`, { status: 'proposed' }),
		)

		expect(res.status).toBe(200)
	})
})
