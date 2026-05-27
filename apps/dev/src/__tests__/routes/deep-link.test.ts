import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const { default: deepLinkRoutes } = await import('../../routes/deep-link')

const wsId = '11111111-1111-1111-1111-111111111111'
const objectId = '22222222-2222-2222-2222-222222222222'

describe('Deep-link redirect routes', () => {
	it('redirects /r/:ws/objects/:id to /:ws/objects/:id and logs the click', async () => {
		const { app, mockResults, calls } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet(`/r/${wsId}/objects/${objectId}?t=get_objects&s=sess-1`))

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}/objects/${objectId}`)

		expect(calls.inserts).toHaveLength(1)
		const inserted = calls.inserts[0] as Record<string, unknown>
		expect(inserted).toMatchObject({
			workspaceId: wsId,
			eventType: 'deep_link_click',
			toolName: 'get_objects',
			sessionId: 'sess-1',
			data: { kind: 'object', targetId: objectId },
		})
	})

	it('redirects /r/:ws to /:ws for the workspace home', async () => {
		const { app, mockResults, calls } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet(`/r/${wsId}?t=list_workspaces`))

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}`)
		expect((calls.inserts[0] as Record<string, unknown>).data).toMatchObject({
			kind: 'workspace',
			targetId: null,
		})
	})

	it('classifies /objects with ?q as a search and forwards the query', async () => {
		const { app, mockResults, calls } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet(`/r/${wsId}/objects?q=launch&t=search_objects`))

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}/objects?q=launch`)
		expect((calls.inserts[0] as Record<string, unknown>).data).toMatchObject({ kind: 'search' })
	})

	it('classifies /objects with ?type as a list view', async () => {
		const { app, mockResults, calls } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet(`/r/${wsId}/objects?type=bet&t=list_objects`))

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}/objects?type=bet`)
		expect((calls.inserts[0] as Record<string, unknown>).data).toMatchObject({ kind: 'list' })
	})

	it('classifies /activity as the unread surface', async () => {
		const { app, mockResults, calls } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet(`/r/${wsId}/activity?t=list_unread&s=sess-2`))

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}/activity`)
		expect((calls.inserts[0] as Record<string, unknown>).data).toMatchObject({
			kind: 'activity',
			targetId: null,
		})
	})

	it('falls back to toolName=unknown when no t param is supplied', async () => {
		const { app, mockResults, calls } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet(`/r/${wsId}/objects/${objectId}`))

		expect(res.status).toBe(302)
		expect((calls.inserts[0] as Record<string, unknown>).toolName).toBe('unknown')
		expect((calls.inserts[0] as Record<string, unknown>).sessionId).toBeNull()
	})

	it('rejects a non-uuid workspace id with 400', async () => {
		const { app, mockResults } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(jsonGet('/r/not-a-uuid/objects/whatever?t=x'))
		expect(res.status).toBe(400)
	})

	it('still redirects when the click log insert fails', async () => {
		const { app, mockResults } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insertError = new Error('boom')

		const res = await app.request(jsonGet(`/r/${wsId}/objects/${objectId}?t=get_objects`))
		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}/objects/${objectId}`)
	})

	it('strips telemetry params (t,s) but forwards everything else', async () => {
		const { app, mockResults } = createTestApp(deepLinkRoutes, '/r')
		mockResults.insert = [{}]

		const res = await app.request(
			jsonGet(`/r/${wsId}/objects?type=bet&status=active&t=list_objects&s=sess-3`),
		)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toBe(`/${wsId}/objects?type=bet&status=active`)
	})
})
