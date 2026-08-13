import { buildCreateNotificationBody, buildNotification, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

const { default: notificationsRoutes } = await import('../../routes/notifications')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

describe('Notifications Routes', () => {
	describe('POST /api/notifications', () => {
		it('creates a notification and returns 201', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insertQueue = [[notification], []]

			const res = await app.request(
				jsonRequest('POST', '/api/notifications', buildCreateNotificationBody(), headers),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
			expect(body.status).toBe('pending')
		})

		it('returns 500 when insert fails', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('POST', '/api/notifications', buildCreateNotificationBody(), headers),
			)

			expect(res.status).toBe(500)
		})

		it('accepts native-array metadata.actions', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insertQueue = [[notification], []]

			const body = buildCreateNotificationBody({
				metadata: {
					actions: [
						{ label: 'Merged, continue', response: 'merged_continue' },
						{ label: 'Not ready yet', response: 'not_ready' },
					],
				},
			})

			const res = await app.request(jsonRequest('POST', '/api/notifications', body, headers))
			expect(res.status).toBe(201)
		})

		it('accepts JSON-stringified metadata.actions (agent compatibility shim)', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.insertQueue = [[notification], []]

			const body = buildCreateNotificationBody({
				metadata: {
					actions: JSON.stringify([{ label: 'Approve', response: 'approved' }]),
				},
			})

			const res = await app.request(jsonRequest('POST', '/api/notifications', body, headers))
			expect(res.status).toBe(201)
		})

		it('rejects malformed metadata.actions strings with 400', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const body = buildCreateNotificationBody({
				metadata: { actions: 'not valid json' },
			})

			const res = await app.request(jsonRequest('POST', '/api/notifications', body, headers))
			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/notifications', () => {
		it('returns 200 with list of notifications', async () => {
			const n1 = buildNotification({ workspaceId: wsId })
			const n2 = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [n1, n2]

			const res = await app.request(jsonGet('/api/notifications', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 200 with empty list', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(jsonGet('/api/notifications', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(0)
		})
	})

	describe('GET /api/notifications/:id', () => {
		it('returns 200 when notification found', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.select = [notification]

			const res = await app.request(jsonGet(`/api/notifications/${notification.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonGet('/api/notifications/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/notifications/:id', () => {
		it('returns 200 when notification updated', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'seen' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// First select: existing notification, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
			mockResults.update = [notification]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('PATCH', `/api/notifications/${notification.id}`, { status: 'seen' }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(notification.id)
		})

		it('returns 404 when notification not found', async () => {
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('PATCH', '/api/notifications/00000000-0000-0000-0000-000000000099', {
					status: 'seen',
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/notifications/:id/respond', () => {
		it('returns 200 and defers the wake by default (no inline session touch)', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'pending' })
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults, sessionManager, calls } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			// notification lookup, membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			// Deferred mode never touches the session manager — the reaper (T4)
			// dispatches based on dispatch_at.
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
			// The update sets dispatchAt to now + 6s and marks wakeDispatched=false
			// so the reaper's partial index picks it up.
			const setValue = calls.updates[0] as {
				dispatchAt?: Date
				wakeDispatched?: boolean
				status?: string
			}
			expect(setValue.status).toBe('resolved')
			expect(setValue.wakeDispatched).toBe(false)
			expect(setValue.dispatchAt).toBeInstanceOf(Date)
			expect((setValue.dispatchAt as Date).getTime()).toBeGreaterThan(Date.now())
		})

		it('spawns a session for the source agent under ?dispatch=immediate', async () => {
			const sourceAgentId = '00000000-0000-0000-0000-0000000000aa'
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceAgentId,
				sessionId: null,
			})
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()], [{ type: 'agent' }]]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond?dispatch=immediate`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			expect(sessionManager.createSession).toHaveBeenCalledWith(
				wsId,
				expect.objectContaining({
					actorId: sourceAgentId,
					actionPrompt: expect.stringContaining('Approved'),
				}),
			)
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
		})

		it('resumes the linked session (paused) under ?dispatch=immediate', async () => {
			const sourceAgentId = '00000000-0000-0000-0000-0000000000aa'
			const linkedSessionId = '00000000-0000-0000-0000-0000000000bb'
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceAgentId,
				sessionId: linkedSessionId,
			})
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			mockResults.selectQueue = [
				[notification],
				[buildWorkspaceMember()],
				[{ type: 'agent' }],
				[{ status: 'paused' }],
			]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond?dispatch=immediate`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			expect(sessionManager.resumeSession).toHaveBeenCalledWith(linkedSessionId)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('skips waking (immediate) when linked session is still active', async () => {
			const sourceAgentId = '00000000-0000-0000-0000-0000000000aa'
			const linkedSessionId = '00000000-0000-0000-0000-0000000000bb'
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceAgentId,
				sessionId: linkedSessionId,
			})
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			mockResults.selectQueue = [
				[notification],
				[buildWorkspaceMember()],
				[{ type: 'agent' }],
				[{ status: 'running' }],
			]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond?dispatch=immediate`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
		})

		it('spawns a continuation session (immediate) when linked session ended', async () => {
			const sourceAgentId = '00000000-0000-0000-0000-0000000000aa'
			const linkedSessionId = '00000000-0000-0000-0000-0000000000bb'
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceAgentId,
				sessionId: linkedSessionId,
			})
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			mockResults.selectQueue = [
				[notification],
				[buildWorkspaceMember()],
				[{ type: 'agent' }],
				[{ status: 'completed' }],
			]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond?dispatch=immediate`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
			expect(sessionManager.createSession).toHaveBeenCalledWith(
				wsId,
				expect.objectContaining({
					actorId: sourceAgentId,
					actionPrompt: expect.stringContaining(linkedSessionId),
					config: expect.objectContaining({
						notification_response: expect.objectContaining({
							continuation_of_session_id: linkedSessionId,
						}),
					}),
				}),
			)
		})

		it('does not wake non-agent source actors even under ?dispatch=immediate', async () => {
			const sourceHumanId = '00000000-0000-0000-0000-0000000000cc'
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceHumanId,
				sessionId: null,
			})
			const resolved = { ...notification, status: 'resolved', resolvedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()], [{ type: 'human' }]]
			mockResults.update = [resolved]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond?dispatch=immediate`,
					{ response: 'Approved' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
		})

		it('returns 400 when notification already resolved', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'resolved' })
			const { app, mockResults } = createSessionTestApp(notificationsRoutes, '/api/notifications')
			// First select: notification lookup, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond`,
					{ response: 'Too late' },
					headers,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('already responded')
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createSessionTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/00000000-0000-0000-0000-000000000099/respond',
					{ response: 'Hello' },
					headers,
				),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/notifications/:id', () => {
		it('returns 200 when notification deleted', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// First select: existing notification, second: membership check
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
			mockResults.insert = []

			const res = await app.request(jsonRequest('DELETE', `/api/notifications/${notification.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonDelete('/api/notifications/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('Workspace membership enforcement', () => {
		it('GET /:id returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(jsonGet(`/api/notifications/${notification.id}`))
			expect(res.status).toBe(404)
		})

		it('PATCH /:id returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(
				jsonRequest('PATCH', `/api/notifications/${notification.id}`, { status: 'seen' }),
			)
			expect(res.status).toBe(404)
		})

		it('POST /:id/respond returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'pending' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${notification.id}/respond`,
					{ response: 'Approved' },
					headers,
				),
			)
			expect(res.status).toBe(404)
		})

		it('DELETE /:id returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			// Notification found, but membership check returns empty
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(jsonDelete(`/api/notifications/${notification.id}`))
			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/notifications — schema enforcement', () => {
		it('returns 400 with structured details when required fields are missing', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				// Missing type + source_actor_id
				jsonRequest('POST', '/api/notifications', { title: 'Hi' }, headers),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
			expect(Array.isArray(body.error.details)).toBe(true)
			const fields = body.error.details.map((d: { field: string }) => d.field)
			expect(fields).toEqual(expect.arrayContaining(['type', 'source_actor_id']))
		})

		it('returns 400 when metadata.options item is malformed', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications',
					buildCreateNotificationBody({
						metadata: { options: [{ label: '', value: 'x' }] },
					}),
					headers,
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
		})
	})

	describe('POST /api/notifications/bulk-respond', () => {
		it('resolves N notifications in one call (deferred)', async () => {
			const sourceA = '00000000-0000-0000-0000-0000000000a1'
			const sourceB = '00000000-0000-0000-0000-0000000000b1'
			const n1 = buildNotification({ workspaceId: wsId, status: 'pending', sourceActorId: sourceA })
			const n2 = buildNotification({ workspaceId: wsId, status: 'pending', sourceActorId: sourceB })
			const n3 = buildNotification({ workspaceId: wsId, status: 'pending', sourceActorId: sourceA })
			const { app, mockResults, sessionManager, calls } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			// selects: membership check (outside txn), then rows fetch inside txn
			mockResults.selectQueue = [[buildWorkspaceMember()], [n1, n2, n3]]
			mockResults.updateQueue = [
				[{ ...n1, status: 'resolved' }],
				[{ ...n2, status: 'resolved' }],
				[{ ...n3, status: 'resolved' }],
			]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond',
					{ ids: [n1.id, n2.id, n3.id], response: 'approve_all' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(3)
			// Deferred mode → no inline session touch
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
			// Dedupe: only 2 unique sources → only 2 updates schedule a wake
			const withDispatch = (calls.updates as Array<Record<string, unknown>>).filter(
				(u) => u.dispatchAt instanceof Date,
			)
			expect(withDispatch).toHaveLength(2)
		})

		it('dedupes wakes per sourceActorId under ?dispatch=immediate', async () => {
			const sourceAgent = '00000000-0000-0000-0000-0000000000c1'
			const n1 = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceAgent,
				sessionId: null,
			})
			const n2 = buildNotification({
				workspaceId: wsId,
				status: 'pending',
				sourceActorId: sourceAgent,
				sessionId: null,
			})
			const { app, mockResults, sessionManager } = createSessionTestApp(
				notificationsRoutes,
				'/api/notifications',
			)
			mockResults.selectQueue = [
				[buildWorkspaceMember()],
				[n1, n2],
				// One source actor lookup after txn (immediate wake loop)
				[{ type: 'agent' }],
			]
			mockResults.updateQueue = [[{ ...n1, status: 'resolved' }], [{ ...n2, status: 'resolved' }]]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond?dispatch=immediate',
					{ ids: [n1.id, n2.id], response: 'go' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			await new Promise((r) => setImmediate(r))
			// Two rows, one source → one wake
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		})

		it('returns 400 if any id is missing', async () => {
			const n1 = buildNotification({ workspaceId: wsId, status: 'pending' })
			const missingId = '00000000-0000-0000-0000-000000000099'
			const { app, mockResults } = createSessionTestApp(notificationsRoutes, '/api/notifications')
			// Membership OK, then rows fetch returns only n1 — missingId absent
			mockResults.selectQueue = [[buildWorkspaceMember()], [n1]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond',
					{ ids: [n1.id, missingId], response: 'x' },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 if any notification is in a wrong workspace', async () => {
			const otherWs = '00000000-0000-0000-0000-0000000000f1'
			const n1 = buildNotification({ workspaceId: wsId, status: 'pending' })
			const n2 = buildNotification({ workspaceId: otherWs, status: 'pending' })
			const { app, mockResults } = createSessionTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[buildWorkspaceMember()], [n1, n2]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond',
					{ ids: [n1.id, n2.id], response: 'x' },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 if any notification is already resolved', async () => {
			const n1 = buildNotification({ workspaceId: wsId, status: 'pending' })
			const n2 = buildNotification({ workspaceId: wsId, status: 'resolved' })
			const { app, mockResults } = createSessionTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[buildWorkspaceMember()], [n1, n2]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond',
					{ ids: [n1.id, n2.id], response: 'x' },
					headers,
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when body is missing ids', async () => {
			const { app } = createSessionTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonRequest('POST', '/api/notifications/bulk-respond', { response: 'x' }, headers),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('POST /api/notifications/:id/reverse', () => {
		it('restores a resolved notification within the 6s window', async () => {
			const resolvedAt = new Date(Date.now() - 2000) // 2s ago
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'resolved',
				resolvedAt,
				metadata: { response: 'approve', asked: 'ok?' },
				dispatchAt: new Date(Date.now() + 4000),
			})
			const restored = { ...notification, status: 'pending', resolvedAt: null, dispatchAt: null }
			const { app, mockResults, calls } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]
			mockResults.update = [restored]
			mockResults.insert = []

			const res = await app.request(
				jsonRequest('POST', `/api/notifications/${notification.id}/reverse`, {}, headers),
			)

			expect(res.status).toBe(200)
			const setValue = calls.updates[0] as {
				status?: string
				resolvedAt?: Date | null
				dispatchAt?: Date | null
				wakeDispatched?: boolean
				metadata?: Record<string, unknown>
			}
			expect(setValue.status).toBe('pending')
			expect(setValue.resolvedAt).toBeNull()
			expect(setValue.dispatchAt).toBeNull()
			expect(setValue.wakeDispatched).toBe(false)
			// metadata.response must be stripped so the reversed row looks pristine
			expect(setValue.metadata).not.toHaveProperty('response')
			expect(setValue.metadata?.asked).toBe('ok?')
		})

		it('returns 400 after the 6s window has elapsed', async () => {
			const resolvedAt = new Date(Date.now() - 10_000) // 10s ago
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'resolved',
				resolvedAt,
			})
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest('POST', `/api/notifications/${notification.id}/reverse`, {}, headers),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('window')
		})

		it('returns 400 when status is not resolved', async () => {
			const notification = buildNotification({ workspaceId: wsId, status: 'pending' })
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[notification], [buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest('POST', `/api/notifications/${notification.id}/reverse`, {}, headers),
			)

			expect(res.status).toBe(400)
		})

		it('returns 404 when notification not found', async () => {
			const { app } = createTestApp(notificationsRoutes, '/api/notifications')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/00000000-0000-0000-0000-000000000099/reverse',
					{},
					headers,
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when actor is not a workspace member', async () => {
			const notification = buildNotification({
				workspaceId: wsId,
				status: 'resolved',
				resolvedAt: new Date(),
			})
			const { app, mockResults } = createTestApp(notificationsRoutes, '/api/notifications')
			mockResults.selectQueue = [[notification], []]

			const res = await app.request(
				jsonRequest('POST', `/api/notifications/${notification.id}/reverse`, {}, headers),
			)

			expect(res.status).toBe(404)
		})
	})
})
