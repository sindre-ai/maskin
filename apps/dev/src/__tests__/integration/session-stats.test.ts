import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { ensureWorkspaceMember, insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

type StatsRow = {
	actor_id: string
	total: number
	active: number
	total_cost_usd: number
	last_30d_cost_usd: number
	latest_status: string
	latest_session_at: string | null
}

const DAY_MS = 86_400_000
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS)

type RequestApp = { request: (req: Request) => Response | Promise<Response> }

async function getStats(app: RequestApp, ws: string) {
	const res = await app.request(jsonGet('/api/sessions/stats', { 'x-workspace-id': ws }))
	expect(res.status).toBe(200)
	return (await res.json()) as StatsRow[]
}

describe('GET /api/sessions/stats (Integration)', () => {
	let workspaceId: string
	let ownerId: string
	let agentA: string
	let agentB: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
		agentA = (await insertActor(db, { type: 'agent' })).id
		agentB = (await insertActor(db, { type: 'agent' })).id
	})

	it('returns one row per agent with counts, cost and the latest status, and no session rows', async () => {
		// Agent A: a running session, a recent settled one with cost, an old settled one with cost,
		// and the newest (by created_at) a failure.
		await insertSession(db, workspaceId, agentA, ownerId, {
			status: 'completed',
			createdAt: daysAgo(60),
			completedAt: daysAgo(45),
			totalCostUsd: '10.25',
		})
		await insertSession(db, workspaceId, agentA, ownerId, {
			status: 'completed',
			createdAt: daysAgo(3),
			completedAt: daysAgo(2),
			totalCostUsd: '1.50',
		})
		await insertSession(db, workspaceId, agentA, ownerId, {
			status: 'running',
			createdAt: daysAgo(1),
		})
		await insertSession(db, workspaceId, agentA, ownerId, {
			status: 'failed',
			createdAt: daysAgo(0.5),
			completedAt: daysAgo(0.5),
		})
		await insertSession(db, workspaceId, agentB, ownerId, {
			status: 'completed',
			createdAt: daysAgo(1),
			completedAt: daysAgo(1),
			totalCostUsd: '0.5',
		})

		const app = createIntegrationApp({ path: '/api/sessions', module: sessionsRoutes })
		const rows = await getStats(app, workspaceId)

		expect(rows).toHaveLength(2)
		const a = rows.find((r) => r.actor_id === agentA)
		expect(a).toMatchObject({
			total: 4,
			active: 1,
			total_cost_usd: 11.75,
			last_30d_cost_usd: 1.5,
			latest_status: 'failed',
		})
		expect(a?.latest_session_at).toEqual(expect.any(String))
		const b = rows.find((r) => r.actor_id === agentB)
		expect(b).toMatchObject({
			total: 1,
			active: 0,
			total_cost_usd: 0.5,
			last_30d_cost_usd: 0.5,
			latest_status: 'completed',
		})
		// Aggregates only: nothing about an individual session leaks into a row.
		expect(Object.keys(a ?? {}).sort()).toEqual([
			'active',
			'actor_id',
			'last_30d_cost_usd',
			'latest_session_at',
			'latest_status',
			'total',
			'total_cost_usd',
		])
	})

	it('counts starting and pending sessions as active', async () => {
		await insertSession(db, workspaceId, agentA, ownerId, { status: 'starting' })
		await insertSession(db, workspaceId, agentA, ownerId, { status: 'pending' })
		await insertSession(db, workspaceId, agentA, ownerId, { status: 'completed' })

		const app = createIntegrationApp({ path: '/api/sessions', module: sessionsRoutes })
		const rows = await getStats(app, workspaceId)

		expect(rows.find((r) => r.actor_id === agentA)).toMatchObject({ total: 3, active: 2 })
	})

	it('is scoped to the requested workspace', async () => {
		const other = await insertWorkspace(db, ownerId)
		await insertSession(db, workspaceId, agentA, ownerId, { status: 'completed' })
		await insertSession(db, other.id, agentB, ownerId, { status: 'completed' })

		const app = createIntegrationApp({ path: '/api/sessions', module: sessionsRoutes })
		const rows = await getStats(app, workspaceId)

		expect(rows.map((r) => r.actor_id)).toEqual([agentA])
	})

	it('returns an empty list for a workspace with no sessions', async () => {
		const app = createIntegrationApp({ path: '/api/sessions', module: sessionsRoutes })
		expect(await getStats(app, workspaceId)).toEqual([])
	})

	it('leaves out sessions a plain member could not open, like the list does', async () => {
		const member = await insertActor(db, { type: 'human' })
		await ensureWorkspaceMember(db, workspaceId, member.id)
		// Private: started by another person. Shared: started by the agent itself.
		await insertSession(db, workspaceId, agentA, ownerId, { status: 'completed' })
		await insertSession(db, workspaceId, agentA, agentA, { status: 'completed' })

		const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string } }>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', member.id)
			await next()
		})
		app.route('/api/sessions', sessionsRoutes as never)

		const rows = await getStats(app, workspaceId)
		expect(rows.find((r) => r.actor_id === agentA)).toMatchObject({ total: 1 })
	})
})
