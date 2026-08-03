import { describe, expect, it } from 'vitest'
import briefingRoutes from '../../routes/briefing'
import { buildObject } from '../factories'
import { jsonGet } from '../helpers'
import { createImportTestApp } from '../setup'

const wsId = '00000000-0000-0000-0000-000000000001'

// Query order inside GET /latest (auth middleware bypassed in tests):
//   1. briefings lookup (latest two)
//   2. attached audio file lookup — skipped when no briefings exist
//   3. unreadDelta count — skipped when no previous briefing exists
describe('GET /api/briefing/latest', () => {
	const requesterId = 'test-actor-id'
	const otherActorId = '11111111-1111-1111-1111-111111111111'
	const latestBriefingId = '22222222-2222-2222-2222-222222222222'
	const previousBriefingId = '33333333-3333-3333-3333-333333333333'
	const audioFileId = '44444444-4444-4444-4444-444444444444'

	it('returns null object + zero delta when no briefing exists', async () => {
		const { app, mockResults } = createImportTestApp(briefingRoutes, '/api/briefing')
		mockResults.selectQueue = [[]]

		const res = await app.request(jsonGet('/api/briefing/latest', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('private, max-age=30')
		const body = (await res.json()) as {
			object: unknown
			audioFileId: string | null
			unreadDelta: number
		}
		expect(body).toEqual({ object: null, audioFileId: null, unreadDelta: 0 })
	})

	it('returns the latest briefing with a null audio id when nothing is attached yet', async () => {
		const { app, mockResults } = createImportTestApp(briefingRoutes, '/api/briefing')
		const latest = buildObject({
			id: latestBriefingId,
			workspaceId: wsId,
			type: 'knowledge',
			title: 'Daily Briefing',
			content: 'Bullet one. Bullet two.',
			metadata: { kind: 'briefing' },
		})
		mockResults.selectQueue = [
			[latest], // briefings query returns only the latest, no previous
			[], // audio join returns no row
		]

		const res = await app.request(jsonGet('/api/briefing/latest', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			object: { id: string; type: string }
			audioFileId: string | null
			unreadDelta: number
		}
		expect(body.object.id).toBe(latestBriefingId)
		expect(body.object.type).toBe('knowledge')
		expect(body.audioFileId).toBeNull()
		expect(body.unreadDelta).toBe(0)
	})

	it('returns the attached audio file id when the T1 pipeline has rendered', async () => {
		const { app, mockResults } = createImportTestApp(briefingRoutes, '/api/briefing')
		const latest = buildObject({
			id: latestBriefingId,
			workspaceId: wsId,
			type: 'knowledge',
			metadata: { kind: 'briefing' },
		})
		mockResults.selectQueue = [
			[latest], // briefings
			[{ fileId: audioFileId }], // audio join
		]

		const res = await app.request(jsonGet('/api/briefing/latest', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { audioFileId: string }
		expect(body.audioFileId).toBe(audioFileId)
	})

	it('counts unreadDelta since the previous briefing and excludes self-authored events', async () => {
		const { app, mockResults } = createImportTestApp(briefingRoutes, '/api/briefing')
		const latest = buildObject({
			id: latestBriefingId,
			workspaceId: wsId,
			type: 'knowledge',
			metadata: { kind: 'briefing' },
			createdAt: new Date('2026-07-21T09:00:00Z'),
		})
		const previous = buildObject({
			id: previousBriefingId,
			workspaceId: wsId,
			type: 'knowledge',
			metadata: { kind: 'briefing' },
			createdAt: new Date('2026-07-20T09:00:00Z'),
		})
		mockResults.selectQueue = [
			[latest, previous], // briefings
			[{ fileId: audioFileId }], // audio join
			[{ value: 7 }], // unread count
		]

		const res = await app.request(
			jsonGet('/api/briefing/latest', { 'x-workspace-id': wsId }),
			undefined,
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { unreadDelta: number; audioFileId: string }
		expect(body.unreadDelta).toBe(7)
		expect(body.audioFileId).toBe(audioFileId)
	})

	it('marks the response private so `unreadDelta` never leaks across users', async () => {
		const { app, mockResults } = createImportTestApp(briefingRoutes, '/api/briefing')
		const latest = buildObject({
			id: latestBriefingId,
			workspaceId: wsId,
			type: 'knowledge',
			metadata: { kind: 'briefing' },
			createdAt: new Date('2026-07-21T09:00:00Z'),
		})
		mockResults.selectQueue = [[latest], []]

		const res = await app.request(jsonGet('/api/briefing/latest', { 'x-workspace-id': wsId }))
		expect(res.headers.get('cache-control')).toBe('private, max-age=30')
		expect(res.headers.get('vary')).toBe('X-Workspace-Id')
		// Confirm identifiers so we're checking behaviour, not just headers.
		expect(requesterId).toBe('test-actor-id')
		expect(otherActorId).not.toBe(requesterId)
	})

	it('returns 400 when x-workspace-id header is missing', async () => {
		const { app } = createImportTestApp(briefingRoutes, '/api/briefing')
		const res = await app.request(jsonGet('/api/briefing/latest'))
		expect(res.status).toBe(400)
	})
})
