import {
	buildCreateRelationshipBody,
	buildObject,
	buildRelationship,
	buildWorkspaceMember,
} from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: relationshipsRoutes } = await import('../../routes/relationships')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Relationships Routes', () => {
	describe('POST /api/relationships', () => {
		it('creates a relationship and returns 201', async () => {
			const rel = buildRelationship()
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.insert = [rel]

			const res = await app.request(
				jsonRequest('POST', '/api/relationships', buildCreateRelationshipBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(rel.id)
			expect(body.type).toBe('informs')
		})

		it('writes the created event with the target object status so triggers can filter on it', async () => {
			const target = buildObject({ status: 'active' })
			const source = buildObject({ status: 'clustered' })
			const rel = buildRelationship({ sourceId: source.id, targetId: target.id })
			const { app, mockResults, calls } = createTestApp(relationshipsRoutes, '/api/relationships')
			// First insert: relationship row. Then a select for the two endpoint objects.
			// Then a second insert: the `created` event for the relationship.
			mockResults.insertQueue = [[rel], []]
			mockResults.select = [source, target]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					buildCreateRelationshipBody({ source_id: source.id, target_id: target.id }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			// First captured insert is the relationship row; second is the event.
			expect(calls.inserts).toHaveLength(2)
			const eventValues = calls.inserts[1] as { entityType: string; data: { targetStatus: string } }
			expect(eventValues.entityType).toBe('relationship')
			expect(eventValues.data.targetStatus).toBe('active')
		})
	})

	describe('GET /api/relationships', () => {
		it('returns 200 with list of relationships', async () => {
			const r1 = buildRelationship()
			const r2 = buildRelationship({ type: 'breaks_into' })
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.select = [r1, r2]

			const res = await app.request(jsonGet('/api/relationships'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('DELETE /api/relationships/:id', () => {
		it('returns 200 when deleted', async () => {
			const sourceObj = buildObject()
			const rel = buildRelationship({ sourceId: sourceObj.id })
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			// First select: relationship, second: source object lookup, third: membership check
			mockResults.selectQueue = [[rel], [sourceObj], [buildWorkspaceMember()]]
			mockResults.insert = [{}] // event

			const res = await app.request(
				jsonDelete(`/api/relationships/${rel.id}`, {
					'X-Workspace-Id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when relationship not found', async () => {
			const { app } = createTestApp(relationshipsRoutes, '/api/relationships')

			const res = await app.request(
				jsonDelete('/api/relationships/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})
})
