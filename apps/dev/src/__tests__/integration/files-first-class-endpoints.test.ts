import { files } from '@maskin/db/schema'
import { buildFile, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: objectsRoutes } = await import('../../routes/objects')

function relApp() {
	return createIntegrationApp({ path: '/api/relationships', module: relationshipsRoutes })
}
function objectsApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

async function insertFileRow(
	workspaceId: string,
	actorId: string,
	overrides?: Record<string, unknown>,
) {
	const row = buildFile({ workspaceId, createdBy: actorId, annotations: undefined, ...overrides })
	// buildFile carries a top-level annotations field the schema doesn't have;
	// strip it before insert.
	const { annotations: _annotations, ...clean } = row as Record<string, unknown>
	const [inserted] = await db
		.insert(files)
		.values(clean as typeof files.$inferInsert)
		.returning()
	return inserted
}

describe('Files as first-class relationship endpoints (Slice 1)', () => {
	let workspaceId: string
	let anchorObjectId: string
	let fileAId: string
	let fileBId: string
	let secondObjectId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const anchor = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			status: 'signal',
			title: 'Anchor bet',
		})
		anchorObjectId = anchor.id
		const other = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'todo',
			title: 'Second object',
		})
		secondObjectId = other.id
		const a = await insertFileRow(workspaceId, getTestActorId(), { name: 'design.md' })
		fileAId = a.id
		const b = await insertFileRow(workspaceId, getTestActorId(), {
			name: 'metrics.csv',
			mimeType: 'text/csv',
		})
		fileBId = b.id
	})

	it('POST + GET /api/relationships round-trips a file endpoint with hydrated title', async () => {
		const app = relApp()
		const createRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					// Caller-supplied labels are ignored; the derive helper resolves
					// them from the endpoint ids.
					source_type: 'object',
					source_id: anchorObjectId,
					target_type: 'object',
					target_id: fileAId,
					type: 'attached',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(createRes.status).toBe(201)
		const created = await createRes.json()
		expect(created.sourceType).toBe('object')
		expect(created.targetType).toBe('file')
		// Post-insert hydration reads back the file's `name` in the title slot
		// where a null used to appear.
		expect(created.sourceTitle).toBe('Anchor bet')
		expect(created.targetTitle).toBe('design.md')

		const listRes = await app.request(jsonGet(`/api/relationships?object_id=${anchorObjectId}`))
		expect(listRes.status).toBe(200)
		const list = await listRes.json()
		const fileEdge = list.find((r: { targetId: string }) => r.targetId === fileAId)
		expect(fileEdge).toBeDefined()
		expect(fileEdge.targetType).toBe('file')
		expect(fileEdge.targetTitle).toBe('design.md')
	})

	it('DELETE /api/relationships/:id succeeds on a file-endpoint edge', async () => {
		const app = relApp()
		const createRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'object',
					source_id: anchorObjectId,
					target_type: 'file',
					target_id: fileAId,
					type: 'attached',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		const created = await createRes.json()

		// Before Slice 1 the workspace check only hit `objects`, so a file-first
		// (source is a file) edge 404s on delete. Construct that shape by writing
		// a file → object edge and deleting via id.
		const inverseRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'file',
					source_id: fileBId,
					target_type: 'object',
					target_id: anchorObjectId,
					type: 'attached',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		const inverse = await inverseRes.json()

		const delTargetRes = await app.request(
			jsonDelete(`/api/relationships/${created.id}`, { 'X-Workspace-Id': workspaceId }),
		)
		expect(delTargetRes.status).toBe(200)

		const delSourceRes = await app.request(
			jsonDelete(`/api/relationships/${inverse.id}`, { 'X-Workspace-Id': workspaceId }),
		)
		expect(delSourceRes.status).toBe(200)
	})

	it('/api/objects/:id/graph hydrates file titles on relationships and keeps filesSummary', async () => {
		const app = objectsApp()
		const rApp = relApp()
		await rApp.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'object',
					source_id: anchorObjectId,
					target_type: 'file',
					target_id: fileAId,
					type: 'attached',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		const graphRes = await app.request(
			jsonGet(`/api/objects/${anchorObjectId}/graph`, { 'X-Workspace-Id': workspaceId }),
		)
		expect(graphRes.status).toBe(200)
		const graph = await graphRes.json()
		// The `files` block (a.k.a. `filesSummary`) is retained for compatibility.
		expect(graph.files.some((f: { id: string }) => f.id === fileAId)).toBe(true)
		// The relationship pointing at the file now carries a hydrated
		// targetTitle instead of null — that's the FE's `fileMap` lookup key.
		const fileEdge = graph.relationships.find((r: { targetId: string }) => r.targetId === fileAId)
		expect(fileEdge).toBeDefined()
		expect(fileEdge.targetTitle).toBe('design.md')
	})

	it('/api/objects/:id/graph/traverse walks THROUGH file endpoints', async () => {
		const app = objectsApp()
		const rApp = relApp()
		// anchor → file → second object. Traversal must reach the second
		// object via the file (previously the file pruned the frontier).
		await rApp.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'object',
					source_id: anchorObjectId,
					target_type: 'file',
					target_id: fileAId,
					type: 'attached',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)
		await rApp.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				{
					source_type: 'file',
					source_id: fileAId,
					target_type: 'object',
					target_id: secondObjectId,
					type: 'relates_to',
				},
				{ 'x-workspace-id': workspaceId },
			),
		)

		const traverseRes = await app.request(
			jsonGet(`/api/objects/${anchorObjectId}/graph/traverse?max_depth=3&max_nodes=50`, {
				'X-Workspace-Id': workspaceId,
			}),
		)
		expect(traverseRes.status).toBe(200)
		const traverse = await traverseRes.json()
		const ids = new Set(traverse.nodes.map((n: { id: string }) => n.id))
		expect(ids.has(fileAId)).toBe(true)
		expect(ids.has(secondObjectId)).toBe(true)
		const fileNode = traverse.nodes.find((n: { id: string }) => n.id === fileAId)
		expect(fileNode.type).toBe('file')
		expect(fileNode.title).toBe('design.md')
	})
})
