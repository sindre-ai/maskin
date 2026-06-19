import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildEvent } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: reactionsRoutes } = await import('../../routes/reactions')

const wsId = '00000000-0000-0000-0000-000000000099'

describe('Reactions Routes', () => {
	describe('POST /api/reactions', () => {
		it('returns 201 when adding a reaction to an in-workspace comment', async () => {
			const objectId = randomUUID()
			const eventId = 4242
			const lookup = buildEvent({
				workspaceId: wsId,
				id: eventId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
			})
			const { app, mockResults, calls } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.select = [lookup]
			// First insert (reactions) returns one row → state changed → events row
			// is emitted as the second insert. Second insert's returning value is
			// irrelevant; default `[]` is fine.
			mockResults.insertQueue = [[{ id: randomUUID() }]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/reactions',
					{ event_id: eventId, emoji: '👍' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			// Two inserts in the same transaction: the reactions row and the
			// realtime-driving `reacted` event row pointing at the parent object.
			expect(calls.inserts.length).toBe(2)
			const reactionInsert = calls.inserts[0] as Record<string, unknown>
			expect(reactionInsert.emoji).toBe('👍')
			expect(reactionInsert.eventId).toBe(eventId)
			const eventInsert = calls.inserts[1] as Record<string, unknown>
			expect(eventInsert.action).toBe('reacted')
			expect(eventInsert.entityType).toBe('object')
			expect(eventInsert.entityId).toBe(objectId)
		})

		it('skips the events row on a duplicate add (onConflictDoNothing returned no rows)', async () => {
			const objectId = randomUUID()
			const eventId = 4242
			const lookup = buildEvent({
				workspaceId: wsId,
				id: eventId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
			})
			const { app, mockResults, calls } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.select = [lookup]
			// onConflictDoNothing suppressed the row → returning is empty → we
			// short-circuit so a retrying client cannot inflate the activity stream.
			mockResults.insertQueue = [[]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/reactions',
					{ event_id: eventId, emoji: '👍' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect(calls.inserts.length).toBe(1)
			const reactionInsert = calls.inserts[0] as Record<string, unknown>
			expect(reactionInsert.emoji).toBe('👍')
			expect(reactionInsert.eventId).toBe(eventId)
		})

		it('returns 404 when target event does not exist', async () => {
			const { app } = createTestApp(reactionsRoutes, '/api/reactions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/reactions',
					{ event_id: 1, emoji: '👍' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target event is in a different workspace', async () => {
			const otherWs = randomUUID()
			const lookup = buildEvent({
				workspaceId: otherWs,
				id: 1,
				action: 'commented',
				entityType: 'object',
				entityId: randomUUID(),
			})
			const { app, mockResults } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.select = [lookup]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/reactions',
					{ event_id: 1, emoji: '👍' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target event is not on an object', async () => {
			const lookup = buildEvent({
				workspaceId: wsId,
				id: 1,
				action: 'created',
				entityType: 'session',
				entityId: randomUUID(),
			})
			const { app, mockResults } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.select = [lookup]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/reactions',
					{ event_id: 1, emoji: '👍' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when emoji is missing', async () => {
			const { app } = createTestApp(reactionsRoutes, '/api/reactions')

			const res = await app.request(
				jsonRequest('POST', '/api/reactions', { event_id: 1 }, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when emoji exceeds max length', async () => {
			const { app } = createTestApp(reactionsRoutes, '/api/reactions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/reactions',
					{ event_id: 1, emoji: 'A'.repeat(64) },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('DELETE /api/reactions', () => {
		it('returns 200 and emits an unreacted event when removing a reaction', async () => {
			const objectId = randomUUID()
			const eventId = 99
			const lookup = buildEvent({
				workspaceId: wsId,
				id: eventId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
			})
			const { app, mockResults, calls } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.select = [lookup]
			// Delete returning a row → state changed → events row is emitted.
			mockResults.delete = [{ id: randomUUID() }]

			const res = await app.request(
				jsonRequest(
					'DELETE',
					'/api/reactions',
					{ event_id: eventId, emoji: '🎉' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			// One insert for the realtime `unreacted` event row; the delete uses
			// `delete`, not insert, so it does not appear in the inserts capture.
			expect(calls.inserts.length).toBe(1)
			const eventInsert = calls.inserts[0] as Record<string, unknown>
			expect(eventInsert.action).toBe('unreacted')
			expect(eventInsert.entityId).toBe(objectId)
		})

		it('skips the events row on a duplicate delete (no matching row to remove)', async () => {
			const objectId = randomUUID()
			const eventId = 99
			const lookup = buildEvent({
				workspaceId: wsId,
				id: eventId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
			})
			const { app, mockResults, calls } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.select = [lookup]
			// Delete with no matching row → returning is empty → we short-circuit
			// so a retrying client cannot inflate the activity stream.
			mockResults.delete = []

			const res = await app.request(
				jsonRequest(
					'DELETE',
					'/api/reactions',
					{ event_id: eventId, emoji: '🎉' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			expect(calls.inserts.length).toBe(0)
		})

		it('returns 404 when target event missing', async () => {
			const { app } = createTestApp(reactionsRoutes, '/api/reactions')

			const res = await app.request(
				jsonRequest(
					'DELETE',
					'/api/reactions',
					{ event_id: 1, emoji: '🎉' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('GET /api/reactions', () => {
		it('returns reactions grouped by event id for the given object', async () => {
			const objectId = randomUUID()
			const ev1 = 10
			const ev2 = 11
			const a1 = randomUUID()
			const a2 = randomUUID()
			const { app, mockResults } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.selectQueue = [
				// First select: object workspace check
				[{ id: objectId }],
				// Second select: events under this object
				[{ id: ev1 }, { id: ev2 }],
				// Third select: reaction rows
				[
					{
						id: randomUUID(),
						workspaceId: wsId,
						eventId: ev1,
						actorId: a1,
						emoji: '👍',
						createdAt: new Date('2026-01-01T00:00:00Z'),
					},
					{
						id: randomUUID(),
						workspaceId: wsId,
						eventId: ev1,
						actorId: a2,
						emoji: '👍',
						createdAt: new Date('2026-01-01T00:00:01Z'),
					},
					{
						id: randomUUID(),
						workspaceId: wsId,
						eventId: ev2,
						actorId: a1,
						emoji: '🎉',
						createdAt: new Date('2026-01-01T00:00:02Z'),
					},
				],
			]

			const res = await app.request(
				jsonGet(`/api/reactions?object_id=${objectId}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.reactionsByEventId[String(ev1)]).toHaveLength(2)
			expect(body.reactionsByEventId[String(ev2)]).toHaveLength(1)
			expect(body.reactionsByEventId[String(ev1)][0].emoji).toBe('👍')
			expect(body.reactionsByEventId[String(ev1)][0].createdAt).toBe('2026-01-01T00:00:00.000Z')
		})

		it('returns empty map when object has no events', async () => {
			const objectId = randomUUID()
			const { app, mockResults } = createTestApp(reactionsRoutes, '/api/reactions')
			mockResults.selectQueue = [[{ id: objectId }], []]

			const res = await app.request(
				jsonGet(`/api/reactions?object_id=${objectId}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.reactionsByEventId).toEqual({})
		})

		it('returns 404 when object is not in workspace', async () => {
			const { app } = createTestApp(reactionsRoutes, '/api/reactions')

			const res = await app.request(
				jsonGet(`/api/reactions?object_id=${randomUUID()}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when object_id is not a uuid', async () => {
			const { app } = createTestApp(reactionsRoutes, '/api/reactions')

			const res = await app.request(
				jsonGet('/api/reactions?object_id=not-a-uuid', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})
	})
})
