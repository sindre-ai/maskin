import { randomUUID } from 'node:crypto'
import { files, objects, relationships } from '@maskin/db/schema'
import { and, eq, inArray, or } from 'drizzle-orm'
import {
	buildCreateRelationshipBody,
	insertActor,
	insertConversation,
	insertObject,
	insertRelationship,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: graphRoutes } = await import('../../routes/graph')
const { default: objectsRoutes } = await import('../../routes/objects')

// The integration harness calls every route as the shared test actor. Workspace
// A belongs to that actor, workspace B to a second actor, so the test actor
// reaches workspace A through the header and holds workspace B ids only as
// foreign body or path values.
function createApp() {
	return createIntegrationApp(
		{ path: '/api/relationships', module: relationshipsRoutes },
		{ path: '/api/graph', module: graphRoutes },
		{ path: '/api/objects', module: objectsRoutes },
	)
}

const FOREIGN_TITLE = 'Workspace B private title'
const FOREIGN_CONTENT = 'Workspace B private content'

describe('Relationship and graph routes are scoped to the header workspace', () => {
	let wsA: string
	let wsB: string
	let aSource: { id: string }
	let aTarget: { id: string }
	let bObject: { id: string }
	let bOther: { id: string }
	let bFile: { id: string }
	let bConversation: { id: string }
	let bSession: { id: string }

	async function edgeCount(ids: string[]) {
		const rows = await db
			.select({ id: relationships.id })
			.from(relationships)
			.where(or(inArray(relationships.sourceId, ids), inArray(relationships.targetId, ids)))
		return rows.length
	}

	beforeEach(async () => {
		const actorA = getTestActorId()
		const actorB = (await insertActor(db)).id
		wsA = (await insertWorkspace(db, actorA)).id
		wsB = (await insertWorkspace(db, actorB)).id
		aSource = await insertObject(db, wsA, actorA, {
			type: 'insight',
			status: 'new',
			title: 'Workspace A source',
		})
		aTarget = await insertObject(db, wsA, actorA, {
			type: 'bet',
			status: 'opportunity',
			title: 'Workspace A target',
		})
		bObject = await insertObject(db, wsB, actorB, {
			type: 'bet',
			status: 'opportunity',
			title: FOREIGN_TITLE,
			content: FOREIGN_CONTENT,
		})
		bOther = await insertObject(db, wsB, actorB, {
			type: 'task',
			status: 'todo',
			title: 'Workspace B second title',
		})
		const [file] = await db
			.insert(files)
			.values({
				workspaceId: wsB,
				name: 'workspace-b-private.md',
				mimeType: 'text/markdown',
				sizeBytes: 10,
				storageKey: `test/${randomUUID()}`,
				createdBy: actorB,
			})
			.returning()
		if (!file) throw new Error('file insert failed')
		bFile = file
		bConversation = await insertConversation(db, wsB, actorB, { title: 'Workspace B chat' })
		bSession = await insertSession(db, wsB, actorB, actorB, {
			actionPrompt: 'Workspace B private prompt',
		})
	})

	describe('GET /api/relationships', () => {
		it('returns same-workspace edges and no edge that touches workspace B', async () => {
			const actorA = getTestActorId()
			const own = await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: aSource.id,
				targetType: 'object',
				targetId: aTarget.id,
				type: 'informs',
			})
			// A key from workspace A forged an edge onto a workspace B object.
			const aToB = await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: aSource.id,
				targetType: 'object',
				targetId: bObject.id,
				type: 'relates_to',
			})
			const bToA = await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: bObject.id,
				targetType: 'object',
				targetId: aTarget.id,
				type: 'relates_to',
			})
			const bToB = await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: bObject.id,
				targetType: 'object',
				targetId: bOther.id,
				type: 'breaks_into',
			})

			const res = await createApp().request(
				jsonGet('/api/relationships?limit=100', { 'x-workspace-id': wsA }),
			)

			expect(res.status).toBe(200)
			const text = await res.text()
			const ids = (JSON.parse(text) as Array<{ id: string }>).map((r) => r.id)
			expect(ids).toContain(own.id)
			for (const foreign of [aToB, bToA, bToB]) expect(ids).not.toContain(foreign.id)
			expect(text).not.toContain(FOREIGN_TITLE)
			expect(text).not.toContain(bObject.id)
		})

		it('returns no edge when filtering by a workspace B object id', async () => {
			await insertRelationship(db, getTestActorId(), {
				sourceType: 'object',
				sourceId: aSource.id,
				targetType: 'object',
				targetId: bObject.id,
				type: 'relates_to',
			})

			const res = await createApp().request(
				jsonGet(`/api/relationships?object_id=${bObject.id}`, { 'x-workspace-id': wsA }),
			)

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual([])
		})

		it('hides an edge to a workspace B file and keeps conversation titles in the workspace', async () => {
			const ownConversation = await insertConversation(db, wsA, getTestActorId(), {
				title: 'Workspace A chat',
			})
			await insertRelationship(db, getTestActorId(), {
				sourceType: 'conversation',
				sourceId: ownConversation.id,
				targetType: 'object',
				targetId: aTarget.id,
				type: 'relates_to',
			})
			await insertRelationship(db, getTestActorId(), {
				sourceType: 'object',
				sourceId: aSource.id,
				targetType: 'file',
				targetId: bFile.id,
				type: 'attached',
			})

			const res = await createApp().request(
				jsonGet('/api/relationships?limit=100', { 'x-workspace-id': wsA }),
			)

			expect(res.status).toBe(200)
			const text = await res.text()
			expect(text).toContain('Workspace A chat')
			expect(text).not.toContain('workspace-b-private.md')
		})
	})

	describe('POST /api/relationships', () => {
		const foreignEndpoints: Array<[string, () => string]> = [
			['object', () => bObject.id],
			['file', () => bFile.id],
			['conversation', () => bConversation.id],
			['session', () => bSession.id],
		]

		for (const [kind, foreignId] of foreignEndpoints) {
			it(`returns 404 and writes no row when the target is a workspace B ${kind}`, async () => {
				const res = await createApp().request(
					jsonRequest(
						'POST',
						'/api/relationships',
						buildCreateRelationshipBody({ source_id: aSource.id, target_id: foreignId() }),
						{ 'x-workspace-id': wsA },
					),
				)

				expect(res.status).toBe(404)
				const text = await res.text()
				expect(text).not.toContain(FOREIGN_TITLE)
				expect(text).not.toContain('workspace-b-private.md')
				expect(await edgeCount([foreignId()])).toBe(0)
			})
		}

		it('returns 404 and writes no row when the source is a workspace B object', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/relationships',
					buildCreateRelationshipBody({ source_id: bObject.id, target_id: aTarget.id }),
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			expect(await res.text()).not.toContain(FOREIGN_TITLE)
			expect(await edgeCount([bObject.id])).toBe(0)
		})

		it('returns 404 on the duplicate path for an edge that already exists in workspace B', async () => {
			const existing = await insertRelationship(db, getTestActorId(), {
				sourceType: 'object',
				sourceId: bObject.id,
				targetType: 'object',
				targetId: bOther.id,
				type: 'breaks_into',
			})

			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/relationships',
					buildCreateRelationshipBody({
						source_id: bObject.id,
						target_id: bOther.id,
						type: 'breaks_into',
					}),
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const text = await res.text()
			expect(text).not.toContain(existing.id)
			expect(text).not.toContain(FOREIGN_TITLE)
		})

		it('still links two objects in the caller workspace', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/relationships',
					buildCreateRelationshipBody({ source_id: aSource.id, target_id: aTarget.id }),
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.sourceTitle).toBe('Workspace A source')
			expect(body.targetTitle).toBe('Workspace A target')
		})
	})

	describe('POST /api/graph', () => {
		it('returns 404 and creates nothing when an edge target is a workspace B object', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'n1', type: 'task', title: 'New in workspace A', status: 'todo' }],
						edges: [{ source: 'n1', target: bObject.id, type: 'relates_to' }],
					},
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const text = await res.text()
			expect(text).not.toContain(FOREIGN_TITLE)
			expect(await edgeCount([bObject.id])).toBe(0)
			const created = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.workspaceId, wsA), eq(objects.title, 'New in workspace A')))
			expect(created).toHaveLength(0)
		})

		it('returns 404 when an edge source is a workspace B object', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'n1', type: 'task', title: 'New in workspace A', status: 'todo' }],
						edges: [{ source: bObject.id, target: 'n1', type: 'relates_to' }],
					},
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			expect(await res.text()).not.toContain(FOREIGN_TITLE)
			expect(await edgeCount([bObject.id])).toBe(0)
		})

		it('returns 404 on the duplicate path for an edge that already exists in workspace B', async () => {
			const existing = await insertRelationship(db, getTestActorId(), {
				sourceType: 'object',
				sourceId: bObject.id,
				targetType: 'object',
				targetId: bOther.id,
				type: 'breaks_into',
			})

			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						// The graph schema requires at least one node; the edge under test
						// is the foreign pair, the node is only there to pass validation.
						nodes: [{ $id: 'n1', type: 'task', title: 'New in workspace A', status: 'todo' }],
						edges: [{ source: bObject.id, target: bOther.id, type: 'breaks_into' }],
					},
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(404)
			const text = await res.text()
			expect(text).not.toContain(existing.id)
			expect(text).not.toContain(FOREIGN_TITLE)
		})

		it('still wires a new node to an existing object in the caller workspace', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'n1', type: 'task', title: 'New in workspace A', status: 'todo' }],
						edges: [{ source: 'n1', target: aTarget.id, type: 'relates_to' }],
					},
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.edges[0].targetTitle).toBe('Workspace A target')
		})

		it('still accepts an about edge to the workspace id and to a member actor', async () => {
			const res = await createApp().request(
				jsonRequest(
					'POST',
					'/api/graph',
					{
						nodes: [{ $id: 'k1', type: 'task', title: 'About the workspace', status: 'todo' }],
						edges: [
							{ source: 'k1', target: wsA, type: 'about' },
							{ source: 'k1', target: getTestActorId(), type: 'about' },
						],
					},
					{ 'x-workspace-id': wsA },
				),
			)

			expect(res.status).toBe(201)
		})
	})

	describe('GET /api/objects/:id/graph', () => {
		it('returns only connected objects from the root workspace', async () => {
			const actorA = getTestActorId()
			await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: aSource.id,
				targetType: 'object',
				targetId: aTarget.id,
				type: 'informs',
			})
			// Forged edge from the root onto a workspace B object.
			await insertRelationship(db, actorA, {
				sourceType: 'object',
				sourceId: aSource.id,
				targetType: 'object',
				targetId: bObject.id,
				type: 'relates_to',
			})

			const res = await createApp().request(
				jsonGet(`/api/objects/${aSource.id}/graph`, { 'x-workspace-id': wsA }),
			)

			expect(res.status).toBe(200)
			const text = await res.text()
			const body = JSON.parse(text) as { connected_objects: Array<{ id: string }> }
			expect(body.connected_objects.map((o) => o.id)).toEqual([aTarget.id])
			expect(text).not.toContain(FOREIGN_TITLE)
			expect(text).not.toContain(FOREIGN_CONTENT)
		})

		it('returns 404 for a root object that lives in workspace B', async () => {
			const res = await createApp().request(
				jsonGet(`/api/objects/${bObject.id}/graph`, { 'x-workspace-id': wsA }),
			)

			expect(res.status).toBe(404)
		})
	})
})
