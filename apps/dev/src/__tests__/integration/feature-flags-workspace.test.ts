import { authMiddleware } from '@maskin/auth'
import { Hono } from 'hono'
import { FLAGS, _resetFeatureFlagConfig } from '../../lib/feature-flags'
import featureFlagsRoutes from '../../routes/feature-flags'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

// The actor seeded in global-setup's beforeAll.
const TEST_API_KEY = 'ank_testintegration'
const FLAG = FLAGS.CAPABILITY_SCAN

type Env = { Variables: { db: typeof db; actorId: string; actorType: string } }

// Same stack as production for this route: the auth middleware (which checks membership when
// X-Workspace-Id is present) and then the route, with the real database behind both.
function createApp() {
	const app = new Hono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.use('*', authMiddleware(db))
	app.route('/api/feature-flags', featureFlagsRoutes as never)
	return app
}

async function flagsFor(workspaceId?: string) {
	const res = await createApp().request(
		jsonGet('/api/feature-flags', {
			Authorization: `Bearer ${TEST_API_KEY}`,
			...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
		}),
	)
	const body =
		res.status === 200 ? ((await res.json()) as { flags: Record<string, boolean> }) : null
	return { status: res.status, flag: body?.flags[FLAG] }
}

describe('GET /api/feature-flags with a workspace header — real membership', () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		_resetFeatureFlagConfig()
	})

	function enableFor(...workspaceIds: string[]) {
		process.env.FF_WORKSPACE_FEATURES = workspaceIds.map((id) => `${id}:${FLAG}`).join(',')
		_resetFeatureFlagConfig()
	}

	it('says true for the workspace it is on for and false for the one it is off for, to a member of both', async () => {
		const a = await insertWorkspace(db, getTestActorId())
		const b = await insertWorkspace(db, getTestActorId())
		if (!a || !b) throw new Error('workspace insert returned no row')
		enableFor(a.id)

		expect(await flagsFor(a.id)).toEqual({ status: 200, flag: true })
		expect(await flagsFor(b.id)).toEqual({ status: 200, flag: false })
	})

	it('never reveals the workspace flag to a caller who is not a member of it', async () => {
		const other = await insertActor(db)
		const outsider = await insertWorkspace(db, other.id)
		const mine = await insertWorkspace(db, getTestActorId())
		if (!outsider || !mine) throw new Error('workspace insert returned no row')
		enableFor(outsider.id, mine.id)

		// The workspace the caller is not in is refused outright; their own still answers.
		const refused = await flagsFor(outsider.id)
		expect(refused.status).toBe(404)
		expect(refused.flag).toBeUndefined()
		expect(await flagsFor(mine.id)).toEqual({ status: 200, flag: true })
	})

	it('answers as before when no header is sent', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		enableFor(ws.id)

		expect(await flagsFor()).toEqual({ status: 200, flag: false })
	})
})
