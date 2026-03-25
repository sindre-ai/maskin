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

	describe('POST /api/relationships - edge cases', () => {
		it('returns 500 when insert returns empty', async () => {
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.insert = [] // empty — insert failed

			const res = await app.request(
				jsonRequest('POST', '/api/relationships', buildCreateRelationshipBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
		})

		it('creates a self-referencing relationship', async () => {
			const objectId = '00000000-0000-0000-0000-000000000010'
			const rel = buildRelationship({ sourceId: objectId, targetId: objectId })
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			mockResults.insert = [rel]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/relationships',
					buildCreateRelationshipBody({ source_id: objectId, target_id: objectId }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.source_id).toBe(body.target_id)
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

		it('returns 404 when source object not found', async () => {
			const rel = buildRelationship()
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			// First select: relationship found, second: source object not found
			mockResults.selectQueue = [[rel], []]

			const res = await app.request(
				jsonDelete(`/api/relationships/${rel.id}`, {
					'X-Workspace-Id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when actor is not a workspace member', async () => {
			const sourceObj = buildObject()
			const rel = buildRelationship({ sourceId: sourceObj.id })
			const { app, mockResults } = createTestApp(relationshipsRoutes, '/api/relationships')
			// First select: relationship, second: source object, third: membership check (empty = not member)
			mockResults.selectQueue = [[rel], [sourceObj], []]

			const res = await app.request(
				jsonDelete(`/api/relationships/${rel.id}`, {
					'X-Workspace-Id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})
})
