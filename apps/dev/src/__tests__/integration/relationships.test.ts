import { buildCreateRelationshipBody, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: relationshipsRoutes } = await import('../../routes/relationships')

function createApp() {
	return createIntegrationApp({ path: '/api/relationships', module: relationshipsRoutes })
}

describe('Relationships Integration', () => {
	let workspaceId: string
	let obj1Id: string
	let obj2Id: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const obj1 = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'insight',
			status: 'new',
		})
		const obj2 = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'bet',
			status: 'signal',
		})
		obj1Id = obj1.id
		obj2Id = obj2.id
	})

	it('creates and lists a relationship', async () => {
		const app = createApp()

		const createRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_id: obj1Id,
					target_id: obj2Id,
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(createRes.status).toBe(201)
		const created = await createRes.json()
		expect(created.sourceId).toBe(obj1Id)
		expect(created.targetId).toBe(obj2Id)

		// List
		const listRes = await app.request(jsonGet(`/api/relationships?source_id=${obj1Id}`))
		expect(listRes.status).toBe(200)
		const list = await listRes.json()
		expect(list).toHaveLength(1)
	})

	it('lists relationships in either direction via object_id', async () => {
		const app = createApp()
		const obj3 = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'task',
			status: 'open',
		})

		// obj1 is the source of an edge to obj2
		await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_id: obj1Id,
					target_id: obj2Id,
					type: 'breaks_into',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		// obj1 is the target of an edge from obj3
		await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_id: obj3.id,
					target_id: obj1Id,
					type: 'breaks_into',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		// object_id should return both edges, regardless of direction
		const res = await app.request(jsonGet(`/api/relationships?object_id=${obj1Id}`))
		expect(res.status).toBe(200)
		const list = await res.json()
		expect(list).toHaveLength(2)
	})

	it('enforces unique constraint on (source, target, type)', async () => {
		const app = createApp()
		const body = buildCreateRelationshipBody({
			source_id: obj1Id,
			target_id: obj2Id,
		})

		// First should succeed
		const first = await app.request(
			jsonRequest('POST', '/api/relationships', body, {
				'x-workspace-id': workspaceId,
			}),
		)
		expect(first.status).toBe(201)

		// Second with same (source, target, type) should fail
		const second = await app.request(
			jsonRequest('POST', '/api/relationships', body, {
				'x-workspace-id': workspaceId,
			}),
		)
		// Unique constraint violation — route doesn't handle duplicates, so DB error surfaces as 500
		expect(second.status).toBe(500)
	})

	it('write-side normalizes divergent source_type/target_type to canonical values', async () => {
		const app = createApp()

		const createRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_id: obj1Id,
					target_id: obj2Id,
					source_type: 'insight',
					target_type: 'bet',
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)

		expect(createRes.status).toBe(201)

		// Fetch the persisted row directly; assert canonical types were stored
		// regardless of what the caller supplied.
		const persisted = await db.query.relationships.findFirst({
			where: (rels, { eq }) => eq(rels.sourceId, obj1Id),
		})
		expect(persisted).not.toBeNull()
		expect(persisted?.sourceType).toBe('object')
		expect(persisted?.targetType).toBe('object')
	})

	it('constraint rejects a raw INSERT with a non-canonical source_type', async () => {
		// The DB CHECK constraint lives at the storage layer, not just the
		// application. A direct INSERT that bypasses the handler must still fail.
		await expect(
			sql`
				INSERT INTO relationships (source_type, source_id, target_type, target_id, type, created_by)
				VALUES ('invalid_type', ${obj1Id}, 'object', ${obj2Id}, 'informs', ${getTestActorId()})
			`,
		).rejects.toThrow()
	})

	it('deletes a relationship', async () => {
		const app = createApp()

		const createRes = await app.request(
			jsonRequest(
				'POST',
				'/api/relationships',
				buildCreateRelationshipBody({
					source_id: obj1Id,
					target_id: obj2Id,
				}),
				{ 'x-workspace-id': workspaceId },
			),
		)
		const created = await createRes.json()

		const deleteRes = await app.request(
			jsonDelete(`/api/relationships/${created.id}`, {
				'X-Workspace-Id': workspaceId,
			}),
		)
		expect(deleteRes.status).toBe(200)

		// Verify gone
		const gone = await app.request(jsonDelete(`/api/relationships/${created.id}`))
		expect(gone.status).toBe(404)
	})
})
