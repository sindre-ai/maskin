import { authMiddleware } from '@maskin/auth'
import { Hono } from 'hono'
import { insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The actor seeded in global-setup's beforeAll — see the INSERT there.
const TEST_API_KEY = 'ank_testintegration'

type Env = {
	Variables: {
		actorId: string
		actorType: string
	}
}

function createApp() {
	const app = new Hono<Env>()
	app.use('*', authMiddleware(db))
	app.get('/test', (c) => c.json({ actorId: c.get('actorId') }))
	return app
}

describe('authMiddleware Integration — X-Workspace-Id validation', () => {
	it('returns a clean 404 instead of a thrown Postgres error when X-Workspace-Id is not a valid UUID', async () => {
		// Regression test for MASKIN-DEV-1/2: workspace_members.workspace_id is a
		// real `uuid` column, so a non-UUID string previously reached the query
		// and Postgres threw 22P02 (invalid_text_representation). A mock DB can
		// never reproduce that failure mode — only a real connection can.
		const app = createApp()

		const res = await app.request(
			jsonGet('/test', {
				Authorization: `Bearer ${TEST_API_KEY}`,
				'X-Workspace-Id': 'not-a-uuid',
			}),
		)

		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body.error.message).toBe('Workspace not found')
	})

	it('passes through against a real membership row when X-Workspace-Id is a valid UUID', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')

		const res = await app.request(
			jsonGet('/test', {
				Authorization: `Bearer ${TEST_API_KEY}`,
				'X-Workspace-Id': ws.id,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.actorId).toBe(getTestActorId())
	})
})
