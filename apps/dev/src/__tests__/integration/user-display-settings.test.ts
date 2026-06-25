import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { userDisplaySettings } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

const { default: userDisplaySettingsRoutes } = await import('../../routes/user-display-settings')

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
	app.route('/api/user-display-settings', userDisplaySettingsRoutes)
	return app
}

describe('User Display Settings Integration', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('persists the All-tab sentinel as its own row, independent of typed rows', async () => {
		const app = appAs(actorId)
		const headers = { 'x-workspace-id': workspaceId }

		// Upsert under `__all__` — the Objects page's All tab uses this slot for
		// its column-visibility state since no concrete object_type applies.
		const allSettings = { columnVisibility: { createdBy: false, 'metadata.foo': true } }
		const putAll = await app.request(
			jsonRequest('PUT', '/api/user-display-settings/__all__', { settings: allSettings }, headers),
		)
		expect(putAll.status).toBe(200)

		// Upsert under a real type — the two rows must coexist, not overwrite
		// each other (unique key is (workspace, actor, object_type, name)).
		const taskSettings = { columnVisibility: { createdBy: true } }
		const putTask = await app.request(
			jsonRequest('PUT', '/api/user-display-settings/task', { settings: taskSettings }, headers),
		)
		expect(putTask.status).toBe(200)

		// GET each key back — values must match what we wrote, not bleed across.
		const getAll = await app.request(jsonGet('/api/user-display-settings/__all__', headers))
		expect(getAll.status).toBe(200)
		expect(await getAll.json()).toMatchObject({
			object_type: '__all__',
			settings: allSettings,
		})

		const getTask = await app.request(jsonGet('/api/user-display-settings/task', headers))
		expect(getTask.status).toBe(200)
		expect(await getTask.json()).toMatchObject({
			object_type: 'task',
			settings: taskSettings,
		})

		// And the underlying table has exactly two rows for this (workspace, actor).
		const rows = await db
			.select()
			.from(userDisplaySettings)
			.where(
				and(
					eq(userDisplaySettings.workspaceId, workspaceId),
					eq(userDisplaySettings.actorId, actorId),
				),
			)
		expect(rows).toHaveLength(2)
		expect(rows.map((r) => r.objectType).sort()).toEqual(['__all__', 'task'])
	})

	it('upsert on the same `__all__` key replaces the prior blob (no duplicate row)', async () => {
		const app = appAs(actorId)
		const headers = { 'x-workspace-id': workspaceId }

		await app.request(
			jsonRequest(
				'PUT',
				'/api/user-display-settings/__all__',
				{ settings: { columnVisibility: { createdBy: false } } },
				headers,
			),
		)
		await app.request(
			jsonRequest(
				'PUT',
				'/api/user-display-settings/__all__',
				{ settings: { columnVisibility: { createdBy: true, 'metadata.bar': false } } },
				headers,
			),
		)

		const rows = await db
			.select()
			.from(userDisplaySettings)
			.where(
				and(
					eq(userDisplaySettings.workspaceId, workspaceId),
					eq(userDisplaySettings.actorId, actorId),
					eq(userDisplaySettings.objectType, '__all__'),
				),
			)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.settings).toEqual({
			columnVisibility: { createdBy: true, 'metadata.bar': false },
		})
	})

	it('rejects an unknown sentinel key', async () => {
		const app = appAs(actorId)
		const headers = { 'x-workspace-id': workspaceId }

		const res = await app.request(
			jsonRequest('PUT', '/api/user-display-settings/__bogus__', { settings: {} }, headers),
		)
		expect(res.status).toBe(400)
	})
})
