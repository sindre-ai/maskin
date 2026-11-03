import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildObject } from '../factories'
import { jsonDelete, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: objectsRoutes } = await import('../../routes/objects')

const wsId = '00000000-0000-0000-0000-000000000001'
const otherWsId = '00000000-0000-0000-0000-000000000002'
const headers = { 'x-workspace-id': wsId }

// Mock-based route coverage for the star/unstar toggle endpoints. Round-trip
// semantics against real Postgres — cross-actor scoping, mutation_type='star'
// tag persisting on the events row, NOTIFY firing — live in
// __tests__/integration/star-state.test.ts.

describe('POST /api/objects/:id/star', () => {
	it('returns 200 with is_starred_by_me: true on happy path', async () => {
		const obj = buildObject({ workspaceId: wsId })
		const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
		// 1) object-fetch, 2) starObject insert.returning() → { starredAt },
		// 3) events insert (no returning).
		mockResults.selectQueue = [[obj]]
		mockResults.insertQueue = [[{ starredAt: new Date('2026-09-08T10:00:00Z') }], []]

		const res = await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, headers),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.is_starred_by_me).toBe(true)
		expect(body.starred_at).toBe('2026-09-08T10:00:00.000Z')
	})

	it('returns 404 when the object does not exist', async () => {
		const { app } = createTestApp(objectsRoutes, '/api/objects')

		const res = await app.request(
			jsonRequest('POST', `/api/objects/${randomUUID()}/star`, undefined, headers),
		)

		expect(res.status).toBe(404)
	})

	it('returns 403 when the object lives in a different workspace', async () => {
		// Cross-workspace guard: authMiddleware verified the caller is a member
		// of `wsId`, but the object's workspace_id says otherwise. Refuse rather
		// than starring an entity the caller could never see.
		const obj = buildObject({ workspaceId: otherWsId })
		const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
		mockResults.selectQueue = [[obj]]

		const res = await app.request(
			jsonRequest('POST', `/api/objects/${obj.id}/star`, undefined, headers),
		)

		expect(res.status).toBe(403)
	})

	it('returns 400 for a malformed object id', async () => {
		const { app } = createTestApp(objectsRoutes, '/api/objects')

		const res = await app.request(
			jsonRequest('POST', '/api/objects/not-a-uuid/star', undefined, headers),
		)

		expect(res.status).toBe(400)
	})
})

describe('DELETE /api/objects/:id/star', () => {
	it('returns 200 with is_starred_by_me: false on happy path', async () => {
		const obj = buildObject({ workspaceId: wsId })
		const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
		mockResults.selectQueue = [[obj]]

		const res = await app.request(jsonDelete(`/api/objects/${obj.id}/star`, headers))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.is_starred_by_me).toBe(false)
		expect(body.starred_at).toBeNull()
	})

	it('returns 200 even when no star row exists (idempotent)', async () => {
		// Same delete path — the mock returns [] for both the missing star_state
		// row and the events insert without a returning() call. The endpoint's
		// contract is "the actor is not starring this after the call succeeds",
		// which holds either way.
		const obj = buildObject({ workspaceId: wsId })
		const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
		mockResults.selectQueue = [[obj]]

		const res = await app.request(jsonDelete(`/api/objects/${obj.id}/star`, headers))

		expect(res.status).toBe(200)
	})

	it('returns 404 when the object does not exist', async () => {
		const { app } = createTestApp(objectsRoutes, '/api/objects')

		const res = await app.request(jsonDelete(`/api/objects/${randomUUID()}/star`, headers))

		expect(res.status).toBe(404)
	})

	it('returns 403 when the object lives in a different workspace', async () => {
		const obj = buildObject({ workspaceId: otherWsId })
		const { app, mockResults } = createTestApp(objectsRoutes, '/api/objects')
		mockResults.selectQueue = [[obj]]

		const res = await app.request(jsonDelete(`/api/objects/${obj.id}/star`, headers))

		expect(res.status).toBe(403)
	})
})
