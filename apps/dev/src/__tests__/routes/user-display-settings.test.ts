import { buildUserDisplaySettings } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: userDisplaySettingsRoutes } = await import('../../routes/user-display-settings')

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = 'test-actor-id'
const headers = { 'x-workspace-id': wsId }

describe('User Display Settings Routes', () => {
	describe('GET /api/user-display-settings', () => {
		it('lists the actor’s default-row settings', async () => {
			const row = buildUserDisplaySettings({ workspaceId: wsId, actorId, objectType: 'task' })
			const { app, mockResults } = createTestApp(
				userDisplaySettingsRoutes,
				'/api/user-display-settings',
			)
			mockResults.select = [row]

			const res = await app.request(jsonGet('/api/user-display-settings', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.items).toHaveLength(1)
			expect(body.items[0]).toMatchObject({
				object_type: 'task',
				name: 'default',
				settings: row.settings,
			})
		})

		it('returns an empty list when nothing is persisted', async () => {
			const { app } = createTestApp(userDisplaySettingsRoutes, '/api/user-display-settings')

			const res = await app.request(jsonGet('/api/user-display-settings', headers))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ items: [] })
		})
	})

	describe('GET /api/user-display-settings/:object_type', () => {
		it('returns 200 with the persisted row', async () => {
			const row = buildUserDisplaySettings({ workspaceId: wsId, actorId, objectType: 'task' })
			const { app, mockResults } = createTestApp(
				userDisplaySettingsRoutes,
				'/api/user-display-settings',
			)
			mockResults.select = [row]

			const res = await app.request(jsonGet('/api/user-display-settings/task', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({
				object_type: 'task',
				name: 'default',
				settings: row.settings,
			})
		})

		it('returns 404 when no row exists for the object type', async () => {
			const { app } = createTestApp(userDisplaySettingsRoutes, '/api/user-display-settings')

			const res = await app.request(jsonGet('/api/user-display-settings/task', headers))

			expect(res.status).toBe(404)
		})

		it('returns 400 for an invalid object_type', async () => {
			const { app } = createTestApp(userDisplaySettingsRoutes, '/api/user-display-settings')

			const res = await app.request(jsonGet('/api/user-display-settings/Not-Valid', headers))

			expect(res.status).toBe(400)
		})
	})

	describe('PUT /api/user-display-settings/:object_type', () => {
		it('upserts and returns the persisted row', async () => {
			const row = buildUserDisplaySettings({
				workspaceId: wsId,
				actorId,
				objectType: 'task',
				settings: { sort: 'title', order: 'asc' },
			})
			const { app, mockResults } = createTestApp(
				userDisplaySettingsRoutes,
				'/api/user-display-settings',
			)
			mockResults.insert = [row]

			const res = await app.request(
				jsonRequest(
					'PUT',
					'/api/user-display-settings/task',
					{ settings: { sort: 'title', order: 'asc' } },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toMatchObject({
				object_type: 'task',
				settings: { sort: 'title', order: 'asc' },
			})
		})

		it('returns 400 when settings is missing from the body', async () => {
			const { app } = createTestApp(userDisplaySettingsRoutes, '/api/user-display-settings')

			const res = await app.request(
				jsonRequest('PUT', '/api/user-display-settings/task', {}, headers),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when settings is not an object', async () => {
			const { app } = createTestApp(userDisplaySettingsRoutes, '/api/user-display-settings')

			const res = await app.request(
				jsonRequest('PUT', '/api/user-display-settings/task', { settings: 'nope' }, headers),
			)

			expect(res.status).toBe(400)
		})
	})
})
