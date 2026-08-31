import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: graphRoutes } = await import('../../routes/graph')
const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp(
		{ path: '/api/graph', module: graphRoutes },
		{ path: '/api/objects', module: objectsRoutes },
	)
}

describe('Graph — bet creation always lands at `signal`', () => {
	let workspaceId: string

	beforeEach(async () => {
		// Use the full bet status list from workspaceSettingsSchema so the
		// signal → define advancement path can be exercised end-to-end.
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work'],
				display_names: {
					insight: 'Insight',
					bet: 'Bet',
					task: 'Task',
					loop: 'Loop',
				},
				statuses: {
					insight: ['new', 'processing', 'clustered', 'discarded'],
					bet: ['signal', 'define', 'active', 'live', 'succeeded', 'failed', 'paused', 'archived'],
					task: ['todo', 'in_progress', 'done', 'blocked'],
					loop: ['running', 'waiting', 'paused', 'archived'],
				},
				field_definitions: {},
				relationship_types: ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates'],
			},
		})
		workspaceId = ws.id
	})

	it('creates a bet at `signal` when no status is supplied', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [{ $id: 'bet-1', type: 'bet', title: 'Ship it' }],
					edges: [],
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.nodes[0].type).toBe('bet')
		expect(body.nodes[0].status).toBe('signal')

		const [row] = await db.select().from(objects).where(eq(objects.id, body.nodes[0].id))
		expect(row.status).toBe('signal')
	})

	it("overrides a caller-supplied 'define' status to `signal` on a bet", async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [{ $id: 'bet-1', type: 'bet', title: 'Ship it', status: 'define' }],
					edges: [],
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.nodes[0].status).toBe('signal')

		const [row] = await db.select().from(objects).where(eq(objects.id, body.nodes[0].id))
		expect(row.status).toBe('signal')
	})

	it("overrides a caller-supplied 'active' status to `signal` on a bet", async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [{ $id: 'bet-1', type: 'bet', title: 'Ship it', status: 'active' }],
					edges: [],
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.nodes[0].status).toBe('signal')
	})

	it('does not override status on non-bet types', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [{ $id: 'task-1', type: 'task', title: 'A task', status: 'in_progress' }],
					edges: [],
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.nodes[0].status).toBe('in_progress')
	})

	it('returns 400 when a non-bet node omits status', async () => {
		const app = createApp()
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [{ $id: 'task-1', type: 'task', title: 'A task' }],
					edges: [],
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain("Missing status for type 'task'")
	})

	it('advancement path signal → define is unaffected by the creation override', async () => {
		const app = createApp()
		// Create the bet via the graph route — should land in `signal` even though
		// the caller tried to jump straight to `define`.
		const createRes = await app.request(
			jsonRequest(
				'POST',
				'/api/graph',
				{
					nodes: [{ $id: 'bet-1', type: 'bet', title: 'Guardrail bet', status: 'define' }],
					edges: [],
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(createRes.status).toBe(201)
		const created = await createRes.json()
		expect(created.nodes[0].status).toBe('signal')
		const betId = created.nodes[0].id

		// signal → define via PATCH.
		const toDefine = await app.request(
			jsonRequest(
				'PATCH',
				`/api/objects/${betId}`,
				{ status: 'define' },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(toDefine.status).toBe(200)
		expect((await toDefine.json()).status).toBe('define')

		const [row] = await db.select().from(objects).where(eq(objects.id, betId))
		expect(row.status).toBe('define')
	})
})
