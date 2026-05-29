import { randomUUID } from 'node:crypto'
import { buildEvent } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

const { default: eventsRoutes } = await import('../../routes/events')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Events Routes', () => {
	describe('GET /api/events/history', () => {
		it('returns 200 with list of events', async () => {
			const e1 = buildEvent({ workspaceId: wsId })
			const e2 = buildEvent({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1, e2]

			const res = await app.request(jsonGet('/api/events/history', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 200 with empty list when no events', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const res = await app.request(jsonGet('/api/events/history', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(0)
		})

		it('accepts filter query parameters', async () => {
			const e1 = buildEvent({ workspaceId: wsId, entityType: 'task', action: 'created' })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1]

			const res = await app.request(
				jsonGet('/api/events/history?entity_type=task&action=created&limit=10', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(Array.isArray(body)).toBe(true)
		})

		it('accepts id filter to fetch a specific event', async () => {
			const e1 = buildEvent({ workspaceId: wsId, id: 77800 })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1]

			const res = await app.request(
				jsonGet('/api/events/history?id=77800', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(77800)
		})
	})

	describe('GET /api/events (SSE stream)', () => {
		it('returns 400 when X-Workspace-Id header is missing', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const res = await app.request(jsonGet('/api/events'))

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('X-Workspace-Id header required')
		})

		it('returns 200 with text/event-stream content-type', async () => {
			const { app } = createTestApp(eventsRoutes, '/api/events')

			const controller = new AbortController()
			const req = new Request('http://localhost/api/events', {
				method: 'GET',
				headers: { 'X-Workspace-Id': wsId },
				signal: controller.signal,
			})

			const res = await app.request(req)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			controller.abort()
		})

		// Smoke test: verifies the SSE endpoint accepts Last-Event-ID without error.
		// Cannot assert replayed content because the stream stays open (active connection).
		it('accepts Last-Event-ID header and returns SSE stream', async () => {
			const e1 = buildEvent({ workspaceId: wsId, id: 5, action: 'created' })
			const e2 = buildEvent({ workspaceId: wsId, id: 6, action: 'updated' })
			const { app, mockResults } = createTestApp(eventsRoutes, '/api/events')
			mockResults.select = [e1, e2]

			const controller = new AbortController()
			const req = new Request('http://localhost/api/events', {
				method: 'GET',
				headers: {
					'X-Workspace-Id': wsId,
					'Last-Event-ID': '4',
				},
				signal: controller.signal,
			})

			const res = await app.request(req)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			controller.abort()
		})
	})

	describe('POST /api/events (create comment)', () => {
		it('returns 201 when creating a comment', async () => {
			const objectId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hello world' },
			})
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			// First select: object lookup, then transaction insert returns comment
			mockResults.selectQueue = [[{ workspaceId: wsId }]]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hello world' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.action).toBe('commented')
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('returns 404 when target object not found', async () => {
			const { app } = createSessionTestApp(eventsRoutes, '/api/events')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: randomUUID(), content: 'Hello' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when object belongs to different workspace', async () => {
			const differentWsId = randomUUID()
			const { app, mockResults } = createSessionTestApp(eventsRoutes, '/api/events')
			// Object found but belongs to different workspace
			mockResults.select = [{ workspaceId: differentWsId }]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: randomUUID(), content: 'Hello' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('creates notifications and spawns a session for @mentioned agent actors', async () => {
			const objectId = randomUUID()
			const agentId = randomUUID()
			const notificationId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @agent', mentions: [agentId] },
			})
			const notification = {
				id: notificationId,
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @agent',
				sourceActorId: 'test-actor-id',
				targetActorId: agentId,
				objectId,
				status: 'pending',
			}
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
			// Object lookup, then inside transaction: insert comment, select mentioned actors, insert notifications, insert notification events
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[{ id: agentId, type: 'agent', name: 'Bot' }],
			]
			mockResults.insert = [commentEvent, notification]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @agent', mentions: [agentId] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(sessionManager.createSession).toHaveBeenCalledWith(
				wsId,
				expect.objectContaining({
					actorId: agentId,
					actionPrompt: expect.stringContaining('Hey @agent'),
					createdBy: 'test-actor-id',
					config: expect.objectContaining({
						mention: expect.objectContaining({
							object_id: objectId,
							notification_id: notificationId,
						}),
					}),
				}),
			)
		})

		it('creates no notifications when mentions array is empty', async () => {
			const objectId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'No mentions here', mentions: [] },
			})
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [[{ workspaceId: wsId }]]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'No mentions here', mentions: [] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.action).toBe('commented')
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('persists attachment_file_ids on the comment when files belong to the workspace', async () => {
			const objectId = randomUUID()
			const fileA = randomUUID()
			const fileB = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: {
					content: 'see attached',
					attachmentFileIds: [fileA, fileB],
				},
			})
			const { app, mockResults, calls } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }], // object lookup
				[{ id: fileA }, { id: fileB }], // files validation
			]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{
						entity_id: objectId,
						content: 'see attached',
						attachment_file_ids: [fileA, fileB],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { data: { attachmentFileIds?: string[] } }
			expect(inserted.data.attachmentFileIds).toEqual([fileA, fileB])
		})

		it('rejects attachment_file_ids when any file does not exist in the workspace', async () => {
			const objectId = randomUUID()
			const fileA = randomUUID()
			const fileB = randomUUID()
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }], // object lookup
				[{ id: fileA }], // files validation: only one of two ids resolved
			]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{
						entity_id: objectId,
						content: 'attached',
						attachment_file_ids: [fileA, fileB],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('attached files')
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('creates batch notifications and spawns a session per mentioned agent', async () => {
			const objectId = randomUUID()
			const agent1Id = randomUUID()
			const agent2Id = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @bot1 @bot2', mentions: [agent1Id, agent2Id] },
			})
			const notification1 = {
				id: randomUUID(),
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @bot1 @bot2',
				sourceActorId: 'test-actor-id',
				targetActorId: agent1Id,
				objectId,
				status: 'pending',
			}
			const notification2 = {
				id: randomUUID(),
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @bot1 @bot2',
				sourceActorId: 'test-actor-id',
				targetActorId: agent2Id,
				objectId,
				status: 'pending',
			}
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[
					{ id: agent1Id, type: 'agent', name: 'Bot1' },
					{ id: agent2Id, type: 'agent', name: 'Bot2' },
				],
			]
			mockResults.insert = [commentEvent, notification1, notification2]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @bot1 @bot2', mentions: [agent1Id, agent2Id] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(2)
			const calledActorIds = (
				sessionManager.createSession as ReturnType<typeof vi.fn>
			).mock.calls.map((call) => call[1].actorId)
			expect(calledActorIds).toContain(agent1Id)
			expect(calledActorIds).toContain(agent2Id)
		})

		it('skips notifications and sessions when mentions only contain human actors', async () => {
			const objectId = randomUUID()
			const humanId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @human', mentions: [humanId] },
			})
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[{ id: humanId, type: 'human', name: 'Alice' }],
			]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @human', mentions: [humanId] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('auto-subscribes each @-mentioned actor to the commented object', async () => {
			const objectId = randomUUID()
			const humanId = randomUUID()
			const agentId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @human @agent', mentions: [humanId, agentId] },
			})
			const { app, mockResults, calls } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				// resolve mentioned actors for notification fan-out
				[
					{ id: humanId, type: 'human', name: 'Alice' },
					{ id: agentId, type: 'agent', name: 'Bot' },
				],
			]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @human @agent', mentions: [humanId, agentId] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			// The route should have called insert(subscriptions).values(...) once with
			// a batch of mentioned actor rows, all carrying source='mentioned'.
			const mentionedInserts = (calls.inserts as unknown[]).filter((arg) => {
				if (!Array.isArray(arg)) return false
				return arg.every(
					(row): row is { source: string; actorId: string } =>
						typeof row === 'object' &&
						row !== null &&
						'source' in row &&
						row.source === 'mentioned',
				)
			})
			expect(mentionedInserts).toHaveLength(1)
			const mentionedRows = mentionedInserts[0] as Array<{ actorId: string; entityId: string }>
			expect(mentionedRows).toHaveLength(2)
			expect(mentionedRows.map((r) => r.actorId).sort()).toEqual([humanId, agentId].sort())
			for (const row of mentionedRows) {
				expect(row.entityId).toBe(objectId)
			}
		})

		it('does not auto-subscribe the commenter under the mentioned source even if they self-mention', async () => {
			const objectId = randomUUID()
			const selfId = randomUUID()
			const otherId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: {
					content: 'I @myself and @other',
					mentions: [selfId, otherId],
				},
			})
			const { app, mockResults, calls } = createSessionTestApp(
				eventsRoutes,
				'/api/events',
				selfId,
			)
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[{ id: otherId, type: 'human', name: 'Other' }],
			]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{
						entity_id: objectId,
						content: 'I @myself and @other',
						mentions: [selfId, otherId],
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const mentionedInserts = (calls.inserts as unknown[]).filter((arg) => {
				if (!Array.isArray(arg)) return false
				return arg.every(
					(row): row is { source: string } =>
						typeof row === 'object' &&
						row !== null &&
						'source' in row &&
						row.source === 'mentioned',
				)
			})
			expect(mentionedInserts).toHaveLength(1)
			const rows = mentionedInserts[0] as Array<{ actorId: string }>
			expect(rows).toHaveLength(1)
			expect(rows[0]?.actorId).toBe(otherId)
		})

		it('keeps parent_event_id when parent is already a top-level comment', async () => {
			const objectId = randomUUID()
			const rootCommentId = 76660
			const rootComment = buildEvent({
				id: rootCommentId,
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Original verdict' },
			})
			const replyEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'first reply', parentEventId: rootCommentId },
			})
			const { app, mockResults, calls } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }], // object lookup
				[rootComment], // parent resolution (root, no parent of its own)
			]
			mockResults.insert = [replyEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'first reply', parent_event_id: rootCommentId },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { data: { parentEventId?: number } }
			expect(inserted.data.parentEventId).toBe(rootCommentId)
		})

		it('collapses reply-to-reply to the thread root parent_event_id', async () => {
			const objectId = randomUUID()
			const rootCommentId = 76660
			const replyCommentId = 78423
			const rootComment = buildEvent({
				id: rootCommentId,
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Original verdict' },
			})
			const replyComment = buildEvent({
				id: replyCommentId,
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'can you summarize?', parentEventId: rootCommentId },
			})
			const grandchildEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'summary reply', parentEventId: rootCommentId },
			})
			const { app, mockResults, calls } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }], // object lookup
				[replyComment], // parent walk: 78423 → has parentEventId 76660
				[rootComment], // parent walk: 76660 → root (no parent)
			]
			mockResults.insert = [grandchildEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'summary reply', parent_event_id: replyCommentId },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { data: { parentEventId?: number } }
			expect(inserted.data.parentEventId).toBe(rootCommentId)
		})

		it('drops parent_event_id when the referenced parent event does not exist', async () => {
			const objectId = randomUUID()
			const missingParentId = 99999
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'orphan reply' },
			})
			const { app, mockResults, calls } = createSessionTestApp(eventsRoutes, '/api/events')
			mockResults.selectQueue = [
				[{ workspaceId: wsId }], // object lookup
				[], // parent lookup: not found
			]
			mockResults.insert = [commentEvent]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'orphan reply', parent_event_id: missingParentId },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { data: { parentEventId?: number } }
			expect(inserted.data.parentEventId).toBeUndefined()
		})

		describe('thread-scoped auto-reply trigger', () => {
			// The thread-reply spawn runs fire-and-forget AFTER the route returns,
			// so tests need a macrotask boundary to let the helper finish its
			// awaited DB queries and call sessionManager.createSession.
			const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve))

			it('spawns a thread-reply session for an agent who previously commented in the thread', async () => {
				const objectId = randomUUID()
				const agentAId = randomUUID()
				const rootCommentId = 700100
				const agentReplyId = 700101
				const newCommentId = 700200

				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'Follow up', parentEventId: rootCommentId },
				})
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
				)
				;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
				mockResults.selectQueue = [
					[{ workspaceId: wsId }], // object lookup
					[{ id: rootCommentId, data: { content: 'Root' } }], // parent walk: root terminates
					// Thread comments query (desc by id): new comment + agent reply + root
					[
						{
							id: newCommentId,
							actorId: 'test-actor-id',
							actorType: 'human',
							data: { content: 'Follow up', parentEventId: rootCommentId },
						},
						{
							id: agentReplyId,
							actorId: agentAId,
							actorType: 'agent',
							data: { content: 'agent reply', parentEventId: rootCommentId },
						},
						{
							id: rootCommentId,
							actorId: randomUUID(),
							actorType: 'human',
							data: { content: 'Root' },
						},
					],
				]
				mockResults.insert = [newComment]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{
							entity_id: objectId,
							content: 'Follow up',
							parent_event_id: rootCommentId,
						},
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
				expect(sessionManager.createSession).toHaveBeenCalledWith(
					wsId,
					expect.objectContaining({
						actorId: agentAId,
						actionPrompt: expect.stringContaining('Follow up'),
						createdBy: 'test-actor-id',
						config: expect.objectContaining({
							thread_reply: expect.objectContaining({
								object_id: objectId,
								comment_event_id: newCommentId,
								thread_root_event_id: rootCommentId,
								commenter_actor_id: 'test-actor-id',
							}),
						}),
					}),
				)
			})

			it('spawns a thread-reply session for an agent only @mentioned earlier in the thread', async () => {
				const objectId = randomUUID()
				const agentAId = randomUUID()
				const rootCommentId = 710100
				const newCommentId = 710200
				const otherHumanId = randomUUID()

				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'follow up', parentEventId: rootCommentId },
				})
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
				)
				;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
				mockResults.selectQueue = [
					[{ workspaceId: wsId }], // object lookup
					[{ id: rootCommentId, data: { content: 'Root' } }], // parent walk
					// Thread comments query: only humans authored, but root @mentions agent A
					[
						{
							id: newCommentId,
							actorId: 'test-actor-id',
							actorType: 'human',
							data: { content: 'follow up', parentEventId: rootCommentId },
						},
						{
							id: rootCommentId,
							actorId: otherHumanId,
							actorType: 'human',
							data: { content: 'Root with @agent', mentions: [agentAId] },
						},
					],
					// Actor resolution for the mentioned candidate
					[{ id: agentAId, type: 'agent' }],
				]
				mockResults.insert = [newComment]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{
							entity_id: objectId,
							content: 'follow up',
							parent_event_id: rootCommentId,
						},
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
				expect(sessionManager.createSession).toHaveBeenCalledWith(
					wsId,
					expect.objectContaining({
						actorId: agentAId,
						config: expect.objectContaining({
							thread_reply: expect.objectContaining({
								object_id: objectId,
								comment_event_id: newCommentId,
							}),
						}),
					}),
				)
			})

			it('does NOT spawn a thread-reply session for the agent who authored the new comment', async () => {
				const objectId = randomUUID()
				const agentAId = '00000000-0000-0000-0000-000000000aaa'
				const rootCommentId = 720100
				const priorAgentReplyId = 720101
				const newCommentId = 720200

				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: agentAId,
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'agent self-reply', parentEventId: rootCommentId },
				})
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
					agentAId,
					'agent',
				)
				;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
				mockResults.selectQueue = [
					[{ workspaceId: wsId }], // object lookup
					[{ id: rootCommentId, data: { content: 'Root' } }], // parent walk
					// Thread comments: new + prior agent A reply + root. Both agent rows
					// are by the current commenter so neither should be spawned.
					[
						{
							id: newCommentId,
							actorId: agentAId,
							actorType: 'agent',
							data: { content: 'agent self-reply', parentEventId: rootCommentId },
						},
						{
							id: priorAgentReplyId,
							actorId: agentAId,
							actorType: 'agent',
							data: { content: 'earlier agent reply', parentEventId: rootCommentId },
						},
						{
							id: rootCommentId,
							actorId: randomUUID(),
							actorType: 'human',
							data: { content: 'Root' },
						},
					],
				]
				mockResults.insert = [newComment]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{
							entity_id: objectId,
							content: 'agent self-reply',
							parent_event_id: rootCommentId,
						},
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})

			it('dedupes against @mention spawns when the same agent is both @mentioned and a prior participant', async () => {
				const objectId = randomUUID()
				const agentAId = randomUUID()
				const notificationId = randomUUID()
				const rootCommentId = 730100
				const priorAgentReplyId = 730101
				const newCommentId = 730200

				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'ping @agent', mentions: [agentAId], parentEventId: rootCommentId },
				})
				const notification = {
					id: notificationId,
					workspaceId: wsId,
					type: 'needs_input',
					title: '@mentioned by comment',
					content: 'ping @agent',
					sourceActorId: 'test-actor-id',
					targetActorId: agentAId,
					objectId,
					status: 'pending',
				}
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
				)
				;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
				mockResults.selectQueue = [
					[{ workspaceId: wsId }], // object lookup
					[{ id: rootCommentId, data: { content: 'Root' } }], // parent walk
					// Mentioned-actor lookup (inside transaction)
					[{ id: agentAId, type: 'agent', name: 'Bot' }],
					// Thread comments query (outside transaction)
					[
						{
							id: newCommentId,
							actorId: 'test-actor-id',
							actorType: 'human',
							data: { content: 'ping @agent', mentions: [agentAId], parentEventId: rootCommentId },
						},
						{
							id: priorAgentReplyId,
							actorId: agentAId,
							actorType: 'agent',
							data: { content: 'earlier reply', parentEventId: rootCommentId },
						},
						{
							id: rootCommentId,
							actorId: randomUUID(),
							actorType: 'human',
							data: { content: 'Root' },
						},
					],
				]
				mockResults.insert = [newComment, notification]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{
							entity_id: objectId,
							content: 'ping @agent',
							mentions: [agentAId],
							parent_event_id: rootCommentId,
						},
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				// Exactly one session — the @mention path. Thread-reply path drops it.
				expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
				expect(sessionManager.createSession).toHaveBeenCalledWith(
					wsId,
					expect.objectContaining({
						actorId: agentAId,
						config: expect.objectContaining({
							mention: expect.objectContaining({ notification_id: notificationId }),
						}),
					}),
				)
			})

			it('does NOT run the thread-reply trigger when the new comment is a root comment', async () => {
				const objectId = randomUUID()
				const newCommentId = 740200
				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'top-level comment' },
				})
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
				)
				mockResults.selectQueue = [[{ workspaceId: wsId }]] // only object lookup
				mockResults.insert = [newComment]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{ entity_id: objectId, content: 'top-level comment' },
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})

			it('skips the thread-reply trigger when the thread already has 5 consecutive agent replies', async () => {
				const objectId = randomUUID()
				const agentNewId = '00000000-0000-0000-0000-000000000a01'
				const rootCommentId = 750100
				const newCommentId = 750200

				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: agentNewId,
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: '5th in a row', parentEventId: rootCommentId },
				})
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
					agentNewId,
					'agent',
				)
				;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})
				// Build a thread where the most recent 5 comments are all agent-authored
				const priorAgents = Array.from({ length: 4 }, () => randomUUID())
				const threadRows = [
					{
						id: newCommentId,
						actorId: agentNewId,
						actorType: 'agent',
						data: { content: '5th in a row', parentEventId: rootCommentId },
					},
					...priorAgents.map((id, idx) => ({
						id: newCommentId - (idx + 1),
						actorId: id,
						actorType: 'agent',
						data: { content: `agent reply ${idx}`, parentEventId: rootCommentId },
					})),
					{
						id: rootCommentId,
						actorId: randomUUID(),
						actorType: 'human',
						data: { content: 'Root' },
					},
				]
				mockResults.selectQueue = [
					[{ workspaceId: wsId }],
					[{ id: rootCommentId, data: { content: 'Root' } }],
					threadRows,
				]
				mockResults.insert = [newComment]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{
							entity_id: objectId,
							content: '5th in a row',
							parent_event_id: rootCommentId,
						},
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})

			it('does NOT spawn for human prior participants (only agents auto-reply)', async () => {
				const objectId = randomUUID()
				const otherHumanId = randomUUID()
				const rootCommentId = 760100
				const newCommentId = 760200
				const newComment = buildEvent({
					id: newCommentId,
					workspaceId: wsId,
					actorId: 'test-actor-id',
					action: 'commented',
					entityType: 'object',
					entityId: objectId,
					data: { content: 'reply', parentEventId: rootCommentId },
				})
				const { app, mockResults, sessionManager } = createSessionTestApp(
					eventsRoutes,
					'/api/events',
				)
				mockResults.selectQueue = [
					[{ workspaceId: wsId }],
					[{ id: rootCommentId, data: { content: 'Root' } }],
					// Both prior thread participants are humans → no agent spawn
					[
						{
							id: newCommentId,
							actorId: 'test-actor-id',
							actorType: 'human',
							data: { content: 'reply', parentEventId: rootCommentId },
						},
						{
							id: rootCommentId,
							actorId: otherHumanId,
							actorType: 'human',
							data: { content: 'Root' },
						},
					],
				]
				mockResults.insert = [newComment]

				const res = await app.request(
					jsonRequest(
						'POST',
						'/api/events',
						{ entity_id: objectId, content: 'reply', parent_event_id: rootCommentId },
						{ 'x-workspace-id': wsId },
					),
				)

				expect(res.status).toBe(201)
				await flushMicrotasks()
				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})
		})

		it('still returns 201 when agent session creation fails asynchronously', async () => {
			const objectId = randomUUID()
			const agentId = randomUUID()
			const commentEvent = buildEvent({
				workspaceId: wsId,
				action: 'commented',
				entityType: 'object',
				entityId: objectId,
				data: { content: 'Hey @agent', mentions: [agentId] },
			})
			const notification = {
				id: randomUUID(),
				workspaceId: wsId,
				type: 'needs_input',
				title: '@mentioned by comment',
				content: 'Hey @agent',
				sourceActorId: 'test-actor-id',
				targetActorId: agentId,
				objectId,
				status: 'pending',
			}
			const { app, mockResults, sessionManager } = createSessionTestApp(eventsRoutes, '/api/events')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('container build failed'),
			)
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[{ id: agentId, type: 'agent', name: 'Bot' }],
			]
			mockResults.insert = [commentEvent, notification]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/events',
					{ entity_id: objectId, content: 'Hey @agent', mentions: [agentId] },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		})
	})
})
