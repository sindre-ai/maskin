import { randomUUID } from 'node:crypto'
import { buildObject, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: starObjectsRoutes } = await import('../../routes/star-objects')

const actorId = 'test-actor-id'

describe('Star Objects Routes', () => {
	describe('POST /api/objects/:id/star', () => {
		it('stars the object for the current actor and returns { starred: true }', async () => {
			const object = buildObject()
			const member = buildWorkspaceMember({ actorId, workspaceId: object.workspaceId })
			const { app, mockResults, calls } = createTestApp(starObjectsRoutes, '/api/objects')
			// select #1 → object lookup, select #2 → workspace member check
			mockResults.selectQueue = [[object], [member]]
			// The insert().onConflictDoNothing().returning() call — non-empty means
			// this was a real transition (not-starred → starred), so the audit
			// event insert should follow.
			mockResults.insertQueue = [[{ objectId: object.id }], [{ id: 1 }]]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${object.id}/star`, undefined, {
					'content-type': 'application/json',
				}),
			)

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ starred: true })

			// Two inserts: the star row + the audit event row
			expect(calls.inserts).toHaveLength(2)
			expect(calls.inserts[0]).toMatchObject({ userId: actorId, objectId: object.id })
			expect(calls.inserts[1]).toMatchObject({
				workspaceId: object.workspaceId,
				actorId,
				action: 'starred',
				entityType: object.type,
				entityId: object.id,
			})
		})

		it('is idempotent: a repeat star is a no-op and skips the audit event', async () => {
			const object = buildObject()
			const member = buildWorkspaceMember({ actorId, workspaceId: object.workspaceId })
			const { app, mockResults, calls } = createTestApp(starObjectsRoutes, '/api/objects')
			mockResults.selectQueue = [[object], [member]]
			// Empty returning() → onConflictDoNothing swallowed the insert — no event
			mockResults.insertQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${object.id}/star`, undefined, {
					'content-type': 'application/json',
				}),
			)

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ starred: true })

			// Only the star-row insert was attempted, no audit event followed
			expect(calls.inserts).toHaveLength(1)
			expect(calls.inserts[0]).toMatchObject({ userId: actorId, objectId: object.id })
		})

		it('returns 404 when the object does not exist', async () => {
			const { app } = createTestApp(starObjectsRoutes, '/api/objects')
			// select #1 → empty → object lookup miss (returns before member check)

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${randomUUID()}/star`, undefined, {
					'content-type': 'application/json',
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when the actor is not a workspace member', async () => {
			const object = buildObject()
			const { app, mockResults, calls } = createTestApp(starObjectsRoutes, '/api/objects')
			// select #1 → object exists, select #2 → workspace member lookup miss
			mockResults.selectQueue = [[object], []]

			const res = await app.request(
				jsonRequest('POST', `/api/objects/${object.id}/star`, undefined, {
					'content-type': 'application/json',
				}),
			)

			expect(res.status).toBe(404)
			// No mutation attempted when access is denied
			expect(calls.inserts).toHaveLength(0)
		})

		it('returns 400 for a non-UUID object id', async () => {
			const { app } = createTestApp(starObjectsRoutes, '/api/objects')
			const res = await app.request(
				jsonRequest('POST', '/api/objects/not-a-uuid/star', undefined, {
					'content-type': 'application/json',
				}),
			)
			expect(res.status).toBe(400)
		})
	})

	describe('DELETE /api/objects/:id/star', () => {
		it('unstars the object for the current actor and returns { starred: false }', async () => {
			const object = buildObject()
			const member = buildWorkspaceMember({ actorId, workspaceId: object.workspaceId })
			const { app, mockResults, calls } = createTestApp(starObjectsRoutes, '/api/objects')
			mockResults.selectQueue = [[object], [member]]
			// delete().returning() → non-empty means a row was actually deleted
			mockResults.delete = [{ objectId: object.id }]
			mockResults.insert = [{ id: 1 }]

			const res = await app.request(jsonDelete(`/api/objects/${object.id}/star`))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ starred: false })

			// One audit event insert for the unstar transition
			expect(calls.inserts).toHaveLength(1)
			expect(calls.inserts[0]).toMatchObject({
				workspaceId: object.workspaceId,
				actorId,
				action: 'unstarred',
				entityType: object.type,
				entityId: object.id,
			})
		})

		it('is idempotent: unstarring an already-unstarred object skips the audit event', async () => {
			const object = buildObject()
			const member = buildWorkspaceMember({ actorId, workspaceId: object.workspaceId })
			const { app, mockResults, calls } = createTestApp(starObjectsRoutes, '/api/objects')
			mockResults.selectQueue = [[object], [member]]
			mockResults.delete = []

			const res = await app.request(jsonDelete(`/api/objects/${object.id}/star`))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ starred: false })

			// No audit event, no insert — nothing changed
			expect(calls.inserts).toHaveLength(0)
		})

		it('returns 404 when the object is not visible to the actor', async () => {
			const object = buildObject()
			const { app, mockResults } = createTestApp(starObjectsRoutes, '/api/objects')
			mockResults.selectQueue = [[object], []]

			const res = await app.request(jsonDelete(`/api/objects/${object.id}/star`))

			expect(res.status).toBe(404)
		})
	})

	describe('GET /api/objects/:id/star', () => {
		it('returns { starred: true } when a row exists', async () => {
			const object = buildObject()
			const member = buildWorkspaceMember({ actorId, workspaceId: object.workspaceId })
			const { app, mockResults } = createTestApp(starObjectsRoutes, '/api/objects')
			// select #1 → object, #2 → member, #3 → star row present
			mockResults.selectQueue = [[object], [member], [{ objectId: object.id }]]

			const res = await app.request(jsonGet(`/api/objects/${object.id}/star`))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ starred: true })
		})

		it('returns { starred: false } when no row exists', async () => {
			const object = buildObject()
			const member = buildWorkspaceMember({ actorId, workspaceId: object.workspaceId })
			const { app, mockResults } = createTestApp(starObjectsRoutes, '/api/objects')
			mockResults.selectQueue = [[object], [member], []]

			const res = await app.request(jsonGet(`/api/objects/${object.id}/star`))

			expect(res.status).toBe(200)
			expect(await res.json()).toEqual({ starred: false })
		})

		it('returns 404 when the object is not visible to the actor', async () => {
			const object = buildObject()
			const { app, mockResults } = createTestApp(starObjectsRoutes, '/api/objects')
			mockResults.selectQueue = [[object], []]

			const res = await app.request(jsonGet(`/api/objects/${object.id}/star`))

			expect(res.status).toBe(404)
		})
	})
})
