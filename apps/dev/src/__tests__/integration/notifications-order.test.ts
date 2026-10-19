import { insertNotification, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: notificationsRoutes } = await import('../../routes/notifications')

describe('GET /api/notifications order', () => {
	it('is ascending by default and newest-first with order=desc', async () => {
		const app = createIntegrationApp({ path: '/api/notifications', module: notificationsRoutes })
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const base = Date.now()
		const ids: string[] = []
		for (let i = 0; i < 3; i++) {
			const n = await insertNotification(db, ws.id, actorId, {
				createdAt: new Date(base + i * 1000),
			})
			ids.push(n.id)
		}
		const headers = { 'X-Workspace-Id': ws.id }

		const asc = await (await app.request(jsonGet('/api/notifications', headers))).json()
		expect(asc.map((n: { id: string }) => n.id)).toEqual(ids)

		const desc = await (await app.request(jsonGet('/api/notifications?order=desc', headers))).json()
		expect(desc.map((n: { id: string }) => n.id)).toEqual([...ids].reverse())
	})
})
