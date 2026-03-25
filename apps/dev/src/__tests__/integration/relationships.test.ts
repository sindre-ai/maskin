import { buildCreateRelationshipBody, insertObject, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

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
