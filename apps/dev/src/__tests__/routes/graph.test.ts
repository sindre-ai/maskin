import { clearModules, registerModule } from '@ai-native/module-sdk'
import { buildCreateGraphBody, buildObject, buildRelationship, buildWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: graphRoutes } = await import('../../routes/graph')

const wsId = '00000000-0000-0000-0000-000000000001'

beforeEach(() => {
	registerModule({
		id: 'work',
		name: 'Work',
		version: '0.0.1',
		objectTypes: [
			{ type: 'insight', label: 'Insight', icon: 'lightbulb', defaultStatuses: ['new'] },
			{ type: 'bet', label: 'Bet', icon: 'target', defaultStatuses: ['active'] },
			{ type: 'task', label: 'Task', icon: 'check-square', defaultStatuses: ['todo'] },
		],
	})
})

afterEach(() => {
	clearModules()
})

describe('Graph Routes', () => {
	describe('POST /api/graph', () => {
		it('creates nodes and edges and returns 201', async () => {
			const ws = buildWorkspace({ id: wsId })
			const obj1 = buildObject({ workspaceId: wsId, type: 'bet' })
			const obj2 = buildObject({ workspaceId: wsId, type: 'task' })
			const rel = buildRelationship({
				sourceId: obj1.id,
				targetId: obj2.id,
				type: 'breaks_into',
			})

			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')

			// select: workspace lookup
			mockResults.selectQueue = [[ws]]
			// insert queue: node1 insert+returning, event insert, node2 insert+returning, event insert, edge insert+returning, event insert
			mockResults.insertQueue = [[obj1], [{}], [obj2], [{}], [rel], [{}]]

			const res = await app.request(
				jsonRequest('POST', '/api/graph', buildCreateGraphBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.nodes).toHaveLength(2)
			expect(body.edges).toHaveLength(1)
		})

		it('returns 404 when workspace not found', async () => {
			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', '/api/graph', buildCreateGraphBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
			const body = await res.json()
			expect(body.error.message).toContain('Workspace not found')
		})

		it('returns 400 for duplicate $id values', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [
							{ $id: 'dup', type: 'task', title: 'A', status: 'todo' },
							{ $id: 'dup', type: 'task', title: 'B', status: 'todo' },
						],
						edges: [],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Duplicate $id')
		})

		it('returns 400 for invalid edge source reference', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'task-1', type: 'task', title: 'A', status: 'todo' }],
						edges: [{ source: 'nonexistent', target: 'task-1', type: 'breaks_into' }],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not a valid $id or UUID')
		})

		it('returns generic 500 on transaction failure (does not leak internal details)', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[ws]]
			// Make insert throw to simulate transaction failure
			mockResults.insert = []
			mockResults.insertQueue = [[]] // empty returning → throws "Failed to create node"

			const res = await app.request(
				jsonRequest('POST', '/api/graph', buildCreateGraphBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.message).toBe('Failed to create graph')
			expect(body.error.code).toBe('INTERNAL_ERROR')
		})

		it('returns 400 for invalid status against workspace settings', async () => {
			const ws = buildWorkspace({ id: wsId })
			const { app, mockResults } = createTestApp(graphRoutes, '/api/graph')
			mockResults.selectQueue = [[ws]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'task-1', type: 'task', title: 'A', status: 'invalid_status' }],
						edges: [],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Invalid status')
		})
	})
})
