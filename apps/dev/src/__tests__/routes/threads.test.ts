import {
	buildActor,
	buildCreateThreadBody,
	buildCreateThreadEventBody,
	buildThread,
	buildThreadEvent,
	buildThreadParticipant,
	buildWorkspaceMember,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createMockSessionManager, createSessionTestApp, createTestApp } from '../setup'

const { default: threadsRoutes } = await import('../../routes/threads')

const wsId = '00000000-0000-0000-0000-000000000001'
const actorId = 'test-actor-id'

describe('Threads Routes', () => {
	describe('POST /api/threads', () => {
		it('creates a thread and returns 201', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId, createdBy: actorId })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const threadEvent = buildThreadEvent({ threadId: thread.id, actorId, kind: 'join' })

			// transaction: insert thread, insert participants, insert thread events, insert workspace event, select participants
			mockResults.insertQueue = [[thread], [participant], [threadEvent], [], [participant]]
			mockResults.selectQueue = [[participant]]

			const res = await app.request(
				jsonRequest('POST', '/api/threads', buildCreateThreadBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(thread.id)
			expect(body.title).toBe(thread.title)
			expect(body.visibility).toBe('channel')
			expect(body.state).toBe('open')
		})

		it('returns 400 for missing title', async () => {
			const { app } = createTestApp(threadsRoutes, '/api/threads')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/threads',
					{ visibility: 'channel' }, // missing title
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/threads', () => {
		it('returns threads for workspace (channel visibility)', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const t1 = buildThread({ workspaceId: wsId })
			const t2 = buildThread({ workspaceId: wsId })

			// select threads, then participants for the returned threads
			mockResults.selectQueue = [
				[t1, t2], // main thread query
				[], // participant query for private threads (none here)
				[], // bulk participant load
			]

			const res = await app.request(jsonGet('/api/threads', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('filters out private threads when actor is not a participant', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const privateThread = buildThread({ workspaceId: wsId, visibility: 'private' })
			const channelThread = buildThread({ workspaceId: wsId, visibility: 'channel' })

			// Returns both threads from DB
			mockResults.selectQueue = [
				[privateThread, channelThread],
				// Check which private threads the actor participates in — returns empty (actor not in private)
				[],
				// Bulk participant load
				[],
			]

			const res = await app.request(jsonGet('/api/threads', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			// private thread filtered out, only channel remains
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(channelThread.id)
		})

		it('includes private threads when actor is a participant', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const privateThread = buildThread({ workspaceId: wsId, visibility: 'private' })
			const participant = buildThreadParticipant({ threadId: privateThread.id, actorId })

			mockResults.selectQueue = [
				[privateThread],
				[participant], // actor is participant in private thread
				[participant], // bulk participant load
			]

			const res = await app.request(jsonGet('/api/threads', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(privateThread.id)
		})
	})

	describe('GET /api/threads/:id', () => {
		it('returns thread with participants and events', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })
			const participant = buildThreadParticipant({ threadId: thread.id })
			const evt = buildThreadEvent({ threadId: thread.id })

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // loadParticipants
				[evt], // threadEvents
			]

			const res = await app.request(
				jsonGet(`/api/threads/${thread.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(thread.id)
			expect(body.participants).toHaveLength(1)
			expect(body.events).toHaveLength(1)
		})

		it('returns 404 when thread not found', async () => {
			const { app } = createTestApp(threadsRoutes, '/api/threads')

			const res = await app.request(
				jsonGet('/api/threads/00000000-0000-0000-0000-000000000099', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 403 for private thread when actor is not a participant', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId, visibility: 'private' })

			mockResults.selectQueue = [
				[thread], // loadThread
				[], // isThreadParticipant — actor not found
			]

			const res = await app.request(
				jsonGet(`/api/threads/${thread.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('POST /api/threads/:id/events', () => {
		it('appends an event and returns 201', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const evt = buildThreadEvent({ threadId: thread.id, actorId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // isThreadParticipant
			]
			mockResults.insertQueue = [[evt], []] // insert event, update thread updatedAt (no-return)
			mockResults.update = []

			const res = await app.request(
				jsonRequest('POST', `/api/threads/${thread.id}/events`, buildCreateThreadEventBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(evt.id)
			expect(body.kind).toBe('message')
		})

		it('returns 403 when actor is not a participant', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[], // isThreadParticipant — not a participant
			]

			const res = await app.request(
				jsonRequest('POST', `/api/threads/${thread.id}/events`, buildCreateThreadEventBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when thread not found', async () => {
			const { app } = createTestApp(threadsRoutes, '/api/threads')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/threads/00000000-0000-0000-0000-000000000099/events',
					buildCreateThreadEventBody(),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('resolves thread on resolve event kind', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const resolveEvt = buildThreadEvent({ threadId: thread.id, actorId, kind: 'resolve' })

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // isThreadParticipant
			]
			mockResults.insertQueue = [[resolveEvt], []] // thread event + workspace event
			mockResults.update = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/threads/${thread.id}/events`,
					buildCreateThreadEventBody({ kind: 'resolve', body: 'Resolved!' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.kind).toBe('resolve')
		})
	})

	describe('PATCH /api/threads/:id', () => {
		it('updates thread title and returns 200', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const updated = { ...thread, title: 'New title' }

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // isThreadParticipant
				[participant], // loadParticipants after update
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/threads/${thread.id}`,
					{ title: 'New title' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
		})

		it('returns 403 when actor is not a participant', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[], // isThreadParticipant — not a participant
			]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/threads/${thread.id}`,
					{ title: 'New title' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('POST /api/threads/:id/events — agent session participation', () => {
		it('yield event transitions thread to waiting state', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId, state: 'open' })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const threadEvent = buildThreadEvent({ threadId: thread.id, actorId, kind: 'yield' })

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // isThreadParticipant
			]
			mockResults.insertQueue = [[threadEvent], []] // insert event, insert workspace event
			mockResults.update = [{ ...thread, state: 'waiting' }]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/threads/${thread.id}/events`,
					buildCreateThreadEventBody({ kind: 'yield', body: 'Need your input' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.kind).toBe('yield')
		})

		it('message event on waiting thread resumes active sessions via writeInput', async () => {
			const { app, mockResults, sessionManager } = createSessionTestApp(
				threadsRoutes,
				'/api/threads',
			)
			const thread = buildThread({ workspaceId: wsId, state: 'waiting' })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const threadEvent = buildThreadEvent({ threadId: thread.id, actorId, kind: 'message' })
			const activeSession = {
				id: '00000000-0000-0000-0000-000000000099',
				threadId: thread.id,
				actorId: '00000000-0000-0000-0000-000000000042',
				status: 'running',
				interactive: true,
			}

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // isThreadParticipant
				[activeSession], // active sessions query
			]
			mockResults.insertQueue = [[threadEvent]] // insert event
			mockResults.update = [{ ...thread, state: 'open' }]

			const writeInputSpy = vi.spyOn(sessionManager, 'writeInput')

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/threads/${thread.id}/events`,
					buildCreateThreadEventBody({ kind: 'message', body: 'Here is my answer' }),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.kind).toBe('message')
			// writeInput is fire-and-forget — flush the microtask queue
			await new Promise((r) => setTimeout(r, 10))
			expect(writeInputSpy).toHaveBeenCalledWith(
				activeSession.id,
				expect.objectContaining({ type: 'user' }),
			)
		})

		it('event with mentions returns 201 and creates the event', async () => {
			// mentions trigger fire-and-forget session spawning; verify the HTTP layer works correctly
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId, state: 'open' })
			const participant = buildThreadParticipant({ threadId: thread.id, actorId })
			const threadEvent = buildThreadEvent({ threadId: thread.id, actorId, kind: 'message' })
			const agentActor = buildActor({ type: 'agent' })
			const member = buildWorkspaceMember({ actorId: agentActor.id, workspaceId: wsId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[participant], // isThreadParticipant
				// spawnMentionedAgents queries (fire-and-forget):
				[agentActor], // actors query for mention IDs
				[member], // isWorkspaceMember for agentActor
				[], // active sessions check
				[], // recent thread events
			]
			mockResults.insertQueue = [[threadEvent], []] // event + participant inserts

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/threads/${thread.id}/events`,
					buildCreateThreadEventBody({
						kind: 'message',
						body: 'Hey @agent please help',
						mentions: [agentActor.id],
					}),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.kind).toBe('message')
			expect(body.threadId).toBe(thread.id)
		})
	})

	describe('POST /api/threads/:id/participants', () => {
		it('adds a participant and returns 201', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })
			const member = buildWorkspaceMember({ actorId, workspaceId: wsId })
			const newActorId = '00000000-0000-0000-0000-000000000042'
			const newParticipant = buildThreadParticipant({ threadId: thread.id, actorId: newActorId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[member], // isWorkspaceMember
				[newParticipant], // existing participant query after insert
			]
			mockResults.insertQueue = [[newParticipant], []] // insert participant + join event

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/threads/${thread.id}/participants`,
					{ actor_id: newActorId, kind: 'human' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.actorId).toBe(newActorId)
		})

		it('returns 403 when actor is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[], // isWorkspaceMember — not a member
			]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/threads/${thread.id}/participants`,
					{ actor_id: '00000000-0000-0000-0000-000000000042', kind: 'human' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('DELETE /api/threads/:id/participants/:actorId', () => {
		it('removes a participant and returns 204', async () => {
			const { app, mockResults } = createTestApp(threadsRoutes, '/api/threads')
			const thread = buildThread({ workspaceId: wsId })
			const member = buildWorkspaceMember({ actorId, workspaceId: wsId })
			const targetActorId = '00000000-0000-0000-0000-000000000042'
			const participant = buildThreadParticipant({ threadId: thread.id, actorId: targetActorId })

			mockResults.selectQueue = [
				[thread], // loadThread
				[member], // isWorkspaceMember
			]
			mockResults.delete = [participant] // delete participant returns the removed row
			mockResults.insert = [] // leave event insert

			const res = await app.request(
				jsonRequest(
					'DELETE',
					`/api/threads/${thread.id}/participants/${targetActorId}`,
					undefined,
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(204)
		})
	})
})
