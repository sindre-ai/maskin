import { randomUUID } from 'node:crypto'
import { buildWorkspaceMember } from '../factories'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: forYouRoutes } = await import('../../routes/for-you')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }
const callerId = randomUUID()

describe('GET /api/for-you for_actor_id', () => {
	it('returns the caller own list when no id is given', async () => {
		const { app } = createTestApp(forYouRoutes, '/api/for-you', callerId)

		const res = await app.request(jsonGet('/api/for-you', headers))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ items: [] })
	})

	it('lets a person name themselves', async () => {
		const { app } = createTestApp(forYouRoutes, '/api/for-you', callerId)

		const res = await app.request(jsonGet(`/api/for-you?for_actor_id=${callerId}`, headers))

		expect(res.status).toBe(200)
	})

	it('returns 403 when a person asks for someone else', async () => {
		const { app } = createTestApp(forYouRoutes, '/api/for-you', callerId)

		const res = await app.request(jsonGet(`/api/for-you?for_actor_id=${randomUUID()}`, headers))

		expect(res.status).toBe(403)
	})

	it('returns 200 when an agent asks for a member', async () => {
		const memberId = randomUUID()
		const { app, mockResults } = createTestApp(forYouRoutes, '/api/for-you', callerId, 'agent')
		mockResults.selectQueue = [[buildWorkspaceMember({ actorId: memberId, workspaceId: wsId })]]

		const res = await app.request(jsonGet(`/api/for-you?for_actor_id=${memberId}`, headers))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ items: [] })
	})

	it('returns 404 when an agent asks for someone who is not a member', async () => {
		const { app } = createTestApp(forYouRoutes, '/api/for-you', callerId, 'agent')
		// No member row queued → the membership lookup finds nothing.

		const res = await app.request(jsonGet(`/api/for-you?for_actor_id=${randomUUID()}`, headers))

		expect(res.status).toBe(404)
	})

	it('returns 400 for an id that is not a uuid', async () => {
		const { app } = createTestApp(forYouRoutes, '/api/for-you', callerId, 'agent')

		const res = await app.request(jsonGet('/api/for-you?for_actor_id=nope', headers))

		expect(res.status).toBe(400)
	})
})
