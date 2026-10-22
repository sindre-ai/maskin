import { randomUUID } from 'node:crypto'
import { buildCreateSessionBody, buildSession, buildSessionLog } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp } from '../setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

const wsId = '00000000-0000-0000-0000-000000000001'

// createSessionTestApp calls as 'test-actor-id', so this session was started by the caller.
const buildOwnSession = (overrides?: Record<string, unknown>) =>
	buildSession({ workspaceId: wsId, createdBy: 'test-actor-id', ...overrides })

describe('Sessions Routes', () => {
	describe('POST /api/sessions', () => {
		it('creates a session and returns 201', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager, mockResults } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
			const createBody = buildCreateSessionBody()
			// startSession() checks the agent is a member of the workspace first.
			mockResults.selectQueue = [[{ id: createBody.actor_id }]]

			const res = await app.request(
				jsonRequest('POST', '/api/sessions', createBody, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(session.id)
			expect(body.status).toBe('running')
		})

		it('persists entry_agent_role onto sessions.config for downstream analytics', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager, mockResults } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
			const createBody = buildCreateSessionBody({
				config: { interactive: true },
				entry_agent_role: 'chief-of-staff',
			})
			// startSession() checks the agent is a member of the workspace first.
			mockResults.selectQueue = [[{ id: createBody.actor_id }]]

			const res = await app.request(
				jsonRequest('POST', '/api/sessions', createBody, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(201)
			const createArgs = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(createArgs?.[0]).toBe(wsId)
			expect(createArgs?.[1]?.config).toMatchObject({
				interactive: true,
				entry_agent_role: 'chief-of-staff',
			})
		})

		it('leaves config untouched when entry_agent_role is omitted', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager, mockResults } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
			const createBody = buildCreateSessionBody({ config: { interactive: true } })
			// startSession() checks the agent is a member of the workspace first.
			mockResults.selectQueue = [[{ id: createBody.actor_id }]]

			await app.request(
				jsonRequest('POST', '/api/sessions', createBody, { 'x-workspace-id': wsId }),
			)

			const createArgs = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(createArgs?.[1]?.config).not.toHaveProperty('entry_agent_role')
		})

		it('returns 404 and starts nothing when the agent is not a member of the workspace', async () => {
			const { app, sessionManager, mockResults } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			// The membership lookup finds no row for the agent in this workspace.
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest('POST', '/api/sessions', buildCreateSessionBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('returns 404 and starts nothing when the conversation is not in the workspace', async () => {
			const { app, sessionManager, mockResults } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			// The conversation lookup, scoped to this workspace, finds nothing.
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({
						config: { conversation: { conversation_id: randomUUID(), message_id: 1 } },
					}),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('GET /api/sessions', () => {
		it('returns 200 with list of sessions', async () => {
			const s1 = buildSession({ workspaceId: wsId })
			const s2 = buildSession({ workspaceId: wsId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [s1, s2]

			const res = await app.request(jsonGet('/api/sessions', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('accepts status query parameter', async () => {
			const s1 = buildSession({ workspaceId: wsId, status: 'completed' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [s1]

			const res = await app.request(
				jsonGet('/api/sessions?status=completed', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].status).toBe('completed')
		})

		it('accepts actor_id query parameter', async () => {
			const actorId = '00000000-0000-0000-0000-000000000042'
			const s1 = buildSession({ workspaceId: wsId, actorId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [s1]

			const res = await app.request(
				jsonGet(`/api/sessions?actor_id=${actorId}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})

		it('accepts mention_object_id query parameter', async () => {
			const objectId = '00000000-0000-0000-0000-0000000000aa'
			const s1 = buildSession({
				workspaceId: wsId,
				config: { mention: { object_id: objectId, comment_event_id: 7 } },
			})
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [s1]

			const res = await app.request(
				jsonGet(`/api/sessions?mention_object_id=${objectId}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})

		it('returns lean rows { id, title, status, updated_at } by default', async () => {
			const s1 = buildSession({
				workspaceId: wsId,
				actionPrompt: 'Investigate the flaky login test',
				status: 'running',
			})
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// Route handler's lean path selects only these columns from the leftJoin.
			// The mock resolves the same rows for every db.select() shape; supply
			// the fields the handler consumes so title synthesis has something to
			// work with.
			mockResults.select = [
				{
					id: s1.id,
					status: s1.status,
					updatedAt: s1.updatedAt,
					actionPrompt: s1.actionPrompt,
					triggerName: null,
				},
			]

			const res = await app.request(jsonGet('/api/sessions', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			// Lean shape carries exactly these four keys and no others — no
			// config, no result, no cost/tokens, no timestamps other than
			// updated_at.
			expect(Object.keys(body[0]).sort()).toEqual(['id', 'status', 'title', 'updated_at'])
			expect(body[0].id).toBe(s1.id)
			expect(body[0].title).toBe('Investigate the flaky login test')
			expect(body[0].status).toBe('running')
		})

		it('synthesizes the title from the trigger name when trigger_id is set', async () => {
			const s1 = buildSession({
				workspaceId: wsId,
				actionPrompt: 'Do the scheduled thing',
			})
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [
				{
					id: s1.id,
					status: s1.status,
					updatedAt: s1.updatedAt,
					actionPrompt: s1.actionPrompt,
					triggerName: 'Nightly triage',
				},
			]

			const res = await app.request(jsonGet('/api/sessions', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].title).toBe('Nightly triage')
		})

		it('truncates a long actionPrompt for the lean title with an ellipsis', async () => {
			const s1 = buildSession({
				workspaceId: wsId,
				actionPrompt:
					'Reproduce the flaky login test, then trace every failing assertion back to whichever fixture set them up',
			})
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [
				{
					id: s1.id,
					status: s1.status,
					updatedAt: s1.updatedAt,
					actionPrompt: s1.actionPrompt,
					triggerName: null,
				},
			]

			const res = await app.request(jsonGet('/api/sessions', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].title.endsWith('…')).toBe(true)
			// Trimmed to under 60 chars including the ellipsis marker.
			expect(body[0].title.length).toBeLessThanOrEqual(60)
		})

		it('falls back to Session <id[:8]> when actionPrompt is empty and no trigger name', async () => {
			const s1 = buildSession({ workspaceId: wsId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [
				{
					id: s1.id,
					status: s1.status,
					updatedAt: s1.updatedAt,
					actionPrompt: '',
					triggerName: null,
				},
			]

			const res = await app.request(jsonGet('/api/sessions', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].title).toBe(`Session ${s1.id.slice(0, 8)}`)
		})

		it("returns today's full session payload when verbose=true", async () => {
			const s1 = buildSession({
				workspaceId: wsId,
				status: 'completed',
				config: { runtime: 'claude-code', timeout_seconds: 600 },
				result: { exit_code: 0 },
				currentActivity: 'Wrapping up',
			})
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [s1]

			const res = await app.request(
				jsonGet('/api/sessions?verbose=true', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			// Verbose payload keeps every field today's list returns — this is
			// the regression pin the spec calls out (§4 backwards-compat).
			expect(body[0].id).toBe(s1.id)
			expect(body[0].workspaceId).toBe(s1.workspaceId)
			expect(body[0].actorId).toBe(s1.actorId)
			expect(body[0].actionPrompt).toBe(s1.actionPrompt)
			expect(body[0].config).toEqual(s1.config)
			expect(body[0].result).toEqual(s1.result)
			expect(body[0].currentActivity).toBe('Wrapping up')
			expect(body[0].status).toBe('completed')
			// Lean-only key must NOT appear on the verbose payload.
			expect(body[0]).not.toHaveProperty('title')
			expect(body[0]).not.toHaveProperty('updated_at')
		})

		it('accepts trigger_id query parameter', async () => {
			const triggerId = '00000000-0000-0000-0000-0000000000bb'
			const s1 = buildSession({ workspaceId: wsId, triggerId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [
				{
					id: s1.id,
					status: s1.status,
					updatedAt: s1.updatedAt,
					actionPrompt: s1.actionPrompt,
					triggerName: 'Some scheduled job',
				},
			]

			const res = await app.request(
				jsonGet(`/api/sessions?trigger_id=${triggerId}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(s1.id)
			expect(body[0].title).toBe('Some scheduled job')
		})

		it('rejects trigger_id that is not a UUID', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions?trigger_id=not-a-uuid', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('accepts the before cursor for backward pagination', async () => {
			const s1 = buildSession({ workspaceId: wsId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [
				{
					id: s1.id,
					status: s1.status,
					updatedAt: s1.updatedAt,
					actionPrompt: s1.actionPrompt,
					triggerName: null,
				},
			]

			const before = '2026-09-01T12:00:00.000Z'
			const res = await app.request(
				jsonGet(`/api/sessions?before=${encodeURIComponent(before)}`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})
	})

	describe('GET /api/sessions/:id', () => {
		it('returns 200 when session found', async () => {
			const session = buildOwnSession()
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(session.id)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions/00000000-0000-0000-0000-000000000099', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('includes currentActivity in response', async () => {
			const session = buildOwnSession({ currentActivity: 'Running tests' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.currentActivity).toBe('Running tests')
		})
	})

	describe('PATCH /api/sessions/:id', () => {
		it('writes currentActivity, fires session_updated event, and returns updated session', async () => {
			const session = buildOwnSession()
			const updated = { ...session, currentActivity: 'Searching codebase' }
			const { app, mockResults, calls } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/sessions/${session.id}`,
					{ current_activity: 'Searching codebase' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.currentActivity).toBe('Searching codebase')
			expect(calls.inserts).toContainEqual(
				expect.objectContaining({
					action: 'session_updated',
					entityType: 'session',
					entityId: session.id,
				}),
			)
		})

		it('clears currentActivity to null', async () => {
			const session = buildOwnSession({ currentActivity: 'Old activity' })
			const updated = { ...session, currentActivity: null }
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/sessions/${session.id}`,
					{ current_activity: null },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.currentActivity).toBeNull()
		})

		describe('who may change current_activity', () => {
			const patchActivity = (sessionId: string) =>
				jsonRequest(
					'PATCH',
					`/api/sessions/${sessionId}`,
					{ current_activity: 'Searching codebase' },
					{ 'x-workspace-id': wsId },
				)

			it('lets the agent running the session write it with its own key', async () => {
				const session = buildSession({
					workspaceId: wsId,
					actorId: 'test-actor-id',
					createdBy: 'someone-else',
				})
				const { app, mockResults } = createSessionTestApp(
					sessionsRoutes,
					'/api/sessions',
					'test-actor-id',
					'agent',
				)
				mockResults.selectQueue = [[session]]
				mockResults.update = [{ ...session, currentActivity: 'Searching codebase' }]

				const res = await app.request(patchActivity(session.id))

				expect(res.status).toBe(200)
				expect((await res.json()).currentActivity).toBe('Searching codebase')
			})

			it('lets the person who started the session write it', async () => {
				const session = buildSession({
					workspaceId: wsId,
					actorId: 'some-agent',
					createdBy: 'test-actor-id',
				})
				const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
				mockResults.selectQueue = [[session]]
				mockResults.update = [{ ...session, currentActivity: 'Searching codebase' }]

				const res = await app.request(patchActivity(session.id))

				expect(res.status).toBe(200)
			})

			it('lets a human admin or owner write it', async () => {
				const session = buildSession({
					workspaceId: wsId,
					actorId: 'some-agent',
					createdBy: 'someone-else',
				})
				const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
				mockResults.selectQueue = [[session], [{ role: 'owner', type: 'human' }]]
				mockResults.update = [{ ...session, currentActivity: 'Searching codebase' }]

				const res = await app.request(patchActivity(session.id))

				expect(res.status).toBe(200)
			})

			it('refuses a member who is neither the actor nor the starter, and stores nothing', async () => {
				const session = buildSession({
					workspaceId: wsId,
					actorId: 'some-agent',
					createdBy: 'someone-else',
					currentActivity: 'Original line',
				})
				const { app, mockResults, calls } = createSessionTestApp(sessionsRoutes, '/api/sessions')
				mockResults.selectQueue = [[session], [{ role: 'member', type: 'human' }]]

				const res = await app.request(patchActivity(session.id))

				expect(res.status).toBe(403)
				expect(calls.updates).toEqual([])
			})

			it('refuses an agent holding an admin role that is not the session actor', async () => {
				const session = buildSession({
					workspaceId: wsId,
					actorId: 'some-agent',
					createdBy: 'someone-else',
				})
				const { app, mockResults, calls } = createSessionTestApp(
					sessionsRoutes,
					'/api/sessions',
					'test-actor-id',
					'agent',
				)
				mockResults.selectQueue = [[session], [{ role: 'admin', type: 'agent' }]]

				const res = await app.request(patchActivity(session.id))

				expect(res.status).toBe(403)
				expect(calls.updates).toEqual([])
			})

			it('applies the same rule to a session started by a trigger', async () => {
				const session = buildSession({
					workspaceId: wsId,
					actorId: 'some-agent',
					triggerId: 'some-trigger',
					createdBy: 'someone-else',
				})
				const { app, mockResults, calls } = createSessionTestApp(sessionsRoutes, '/api/sessions')
				mockResults.selectQueue = [[session], []]

				const res = await app.request(patchActivity(session.id))

				expect(res.status).toBe(403)
				expect(calls.updates).toEqual([])
			})
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonRequest(
					'PATCH',
					'/api/sessions/00000000-0000-0000-0000-000000000099',
					{ current_activity: 'anything' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('sets notify_on_complete for the actor who started the session', async () => {
			const session = buildSession({
				workspaceId: wsId,
				createdBy: 'test-actor-id',
				spawnedBySessionId: 'parent-session-id',
			})
			const updated = { ...session, config: { notify_on_complete: true } }
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/sessions/${session.id}`,
					{ notify_on_complete: true },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			expect((await res.json()).config).toEqual({ notify_on_complete: true })
		})

		it('refuses notify_on_complete from an actor who did not start the session', async () => {
			const session = buildSession({ workspaceId: wsId, createdBy: 'someone-else' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/sessions/${session.id}`,
					{ notify_on_complete: true },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
		})

		it('rejects a body with neither current_activity nor notify_on_complete', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.select = [session]

			const res = await app.request(
				jsonRequest('PATCH', `/api/sessions/${session.id}`, {}, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('POST /api/sessions/:id/stop', () => {
		it('returns 200 when session stopped', async () => {
			const session = buildOwnSession({ status: 'completed' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			// First select: auth check, second select: re-fetch after stop
			mockResults.selectQueue = [[session], [session]]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonRequest('POST', '/api/sessions/00000000-0000-0000-0000-000000000099/stop', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when sessionManager throws', async () => {
			const session = buildOwnSession()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Session is not running'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not running')
		})
	})

	describe('POST /api/sessions/:id/pause', () => {
		it('returns 200 when session paused', async () => {
			const session = buildOwnSession({ status: 'paused' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], [session]]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonRequest('POST', '/api/sessions/00000000-0000-0000-0000-000000000099/pause', undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when pauseSession throws', async () => {
			const session = buildOwnSession()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Session is not running'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not running')
		})
	})

	describe('POST /api/sessions/:id/resume', () => {
		it('returns 200 when session resumed', async () => {
			const session = buildOwnSession({ status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], [session]]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
		})

		it('returns 400 when sessionManager throws', async () => {
			const session = buildOwnSession()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Session is not paused'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('not paused')
		})
	})

	describe('POST /api/sessions/:id/input', () => {
		it('returns 200 and forwards formatted payload when session is interactive + running', async () => {
			const session = buildOwnSession({ interactive: true, status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.writeInput as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hello workspace coach' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toEqual({ ok: true })
			expect(sessionManager.writeInput).toHaveBeenCalledWith(
				session.id,
				{
					type: 'user',
					message: { role: 'user', content: 'hello workspace coach' },
				},
				undefined,
			)
		})

		// AC-T2: the input route forwards attachments through as a side-channel
		// so writeInput can persist them in the session_logs envelope (as
		// `maskin_attachments`) without leaking them to the CLI's stdin. This
		// is what lets reload render image attachments inline without a
		// second POST to `/files`.
		it('forwards attachments to writeInput as a separate maskinAttachments argument', async () => {
			const session = buildOwnSession({ interactive: true, status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.writeInput as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const attachments = [
				{
					kind: 'file',
					id: '00000000-0000-0000-0000-000000000abc',
					name: 'photo.png',
					mime_type: 'image/png',
					size_bytes: 4096,
				},
				{ kind: 'object', id: '00000000-0000-0000-0000-000000000123' },
			]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'what about this?', attachments },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			expect(sessionManager.writeInput).toHaveBeenCalledWith(
				session.id,
				{
					type: 'user',
					message: { role: 'user', content: 'what about this?' },
				},
				attachments,
			)
		})

		it('returns 403 and writes nothing when another member started the session', async () => {
			const session = buildOwnSession({
				interactive: true,
				status: 'running',
				createdBy: 'someone-else',
			})
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('FORBIDDEN')
			expect(sessionManager.writeInput).not.toHaveBeenCalled()
		})

		it('returns 403 and writes nothing when the caller is another agent', async () => {
			const session = buildOwnSession({ interactive: true, status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
				'other-agent-id',
				'agent',
			)
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
			expect(sessionManager.writeInput).not.toHaveBeenCalled()
		})

		it('returns 403 before the state checks so a stranger cannot probe session state', async () => {
			const session = buildOwnSession({
				interactive: false,
				status: 'completed',
				createdBy: 'someone-else',
			})
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions/00000000-0000-0000-0000-000000000099/input',
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(404)
		})

		it('returns 409 when session is not interactive', async () => {
			const session = buildOwnSession({ interactive: false, status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.message).toContain('not interactive')
			expect(sessionManager.writeInput).not.toHaveBeenCalled()
		})

		it('returns 409 when interactive session is not in running state', async () => {
			const session = buildOwnSession({ interactive: true, status: 'paused' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.message).toContain('not running')
			expect(sessionManager.writeInput).not.toHaveBeenCalled()
		})

		it('returns 400 when writeInput throws (e.g. no stdin stream attached)', async () => {
			const session = buildOwnSession({ interactive: true, status: 'running' })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session]]
			;(sessionManager.writeInput as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('No stdin stream attached for session'),
			)

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/sessions/${session.id}/input`,
					{ content: 'hi' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('No stdin stream attached')
		})

		it('returns 400 when content is missing', async () => {
			const session = buildOwnSession({ interactive: true, status: 'running' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/input`, {}, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/sessions/:id/logs', () => {
		it('returns 200 with session logs', async () => {
			const session = buildOwnSession()
			const log1 = buildSessionLog({ sessionId: session.id })
			const log2 = buildSessionLog({ sessionId: session.id })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// First select: auth check, second select: logs query
			mockResults.selectQueue = [[session], [log1, log2]]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions/00000000-0000-0000-0000-000000000099/logs', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('GET /api/sessions/:id (with include_logs)', () => {
		it('include_logs=true returns a logs array and honors log_limit', async () => {
			const session = buildOwnSession()
			const log1 = buildSessionLog({ sessionId: session.id })
			const log2 = buildSessionLog({ sessionId: session.id })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// First select: session auth check. Second select: logs query.
			mockResults.selectQueue = [[session], [log1, log2]]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}?include_logs=true&log_limit=25`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(session.id)
			expect(body.logs).toHaveLength(2)
			expect(body.logs[0].content).toBe(log1.content)
		})

		it('include_logs omitted returns session without a logs key (bug fix regression pin)', async () => {
			const session = buildOwnSession()
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session]]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).not.toHaveProperty('logs')
		})
	})

	describe('GET /api/sessions/:id/logs/deep', () => {
		it('direction=newest_first returns rows in id DESC order (NOT reversed)', async () => {
			const session = buildOwnSession()
			// Rows returned by the DB in DESC order — the handler must NOT
			// reverse them (deliberate break from /:id/logs at 712-798).
			const log100 = buildSessionLog({ sessionId: session.id, id: 100, content: 'newest' })
			const log50 = buildSessionLog({ sessionId: session.id, id: 50, content: 'mid' })
			const log10 = buildSessionLog({ sessionId: session.id, id: 10, content: 'oldest' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session], [log100, log50, log10]]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs/deep`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(3)
			expect(body[0].id).toBe(100)
			expect(body[2].id).toBe(10)
		})

		it('direction=oldest_first returns rows in id ASC order (jump to boot)', async () => {
			const session = buildOwnSession()
			const log10 = buildSessionLog({ sessionId: session.id, id: 10, content: 'boot' })
			const log50 = buildSessionLog({ sessionId: session.id, id: 50, content: 'mid' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session], [log10, log50]]

			const res = await app.request(
				jsonGet(`/api/sessions/${session.id}/logs/deep?direction=oldest_first`, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body[0].id).toBe(10)
			expect(body[1].id).toBe(50)
		})

		it('honors before_id, after_id, stream and limit (parses without error)', async () => {
			const session = buildOwnSession()
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session], []]

			const res = await app.request(
				jsonGet(
					`/api/sessions/${session.id}/logs/deep?before_id=100&after_id=10&stream=stderr&limit=25`,
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions/00000000-0000-0000-0000-000000000099/logs/deep', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('Session re-fetch null safety', () => {
		it('POST /stop returns 404 when session disappears after stop', async () => {
			const session = buildOwnSession()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			// Auth check finds session, but re-fetch after stop returns empty
			mockResults.selectQueue = [[session], []]
			;(sessionManager.stopSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('POST /pause returns 404 when session disappears after pause', async () => {
			const session = buildOwnSession()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], []]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('POST /resume returns 404 when session disappears after resume', async () => {
			const session = buildOwnSession()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			mockResults.selectQueue = [[session], []]
			;(sessionManager.resumeSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

			const res = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/resume`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('GET /api/sessions/:id/logs/stream (SSE)', () => {
		it('returns 400 when x-workspace-id header is missing', async () => {
			const session = buildOwnSession()
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs/stream`))

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Missing x-workspace-id header')
		})

		it('returns 404 when session not found', async () => {
			const { app } = createSessionTestApp(sessionsRoutes, '/api/sessions')

			const res = await app.request(
				jsonGet('/api/sessions/00000000-0000-0000-0000-000000000099/logs/stream', {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 200 with text/event-stream content-type for active session', async () => {
			const session = buildOwnSession({ status: 'running' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// First select: auth check, second select: session status check (running)
			mockResults.selectQueue = [[session], [session]]

			const controller = new AbortController()
			const req = new Request(`http://localhost/api/sessions/${session.id}/logs/stream`, {
				method: 'GET',
				headers: { 'x-workspace-id': wsId },
				signal: controller.signal,
			})

			const res = await app.request(req)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			controller.abort()
		})

		it('replays all logs and sends done event for completed session', async () => {
			const session = buildOwnSession({ status: 'completed' })
			const log1 = buildSessionLog({ sessionId: session.id, content: 'line 1' })
			const log2 = buildSessionLog({ sessionId: session.id, content: 'line 2' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// Auth check, session status check (completed), replay all logs
			mockResults.selectQueue = [[session], [session], [log1, log2]]

			const res = await app.request(
				new Request(`http://localhost/api/sessions/${session.id}/logs/stream`, {
					method: 'GET',
					headers: { 'x-workspace-id': wsId },
				}),
			)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			const text = await res.text()
			expect(text).toContain('line 1')
			expect(text).toContain('line 2')
			expect(text).toContain('event: done')
			expect(text).toContain('data: completed')
		})

		it('replays all logs and sends done event for failed session', async () => {
			const session = buildOwnSession({ status: 'failed' })
			const log1 = buildSessionLog({ sessionId: session.id, content: 'error output' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			mockResults.selectQueue = [[session], [session], [log1]]

			const res = await app.request(
				new Request(`http://localhost/api/sessions/${session.id}/logs/stream`, {
					method: 'GET',
					headers: { 'x-workspace-id': wsId },
				}),
			)

			expect(res.status).toBe(200)
			const text = await res.text()
			expect(text).toContain('error output')
			expect(text).toContain('event: done')
			expect(text).toContain('data: failed')
		})

		it('replays missed logs when Last-Event-ID is provided for active session', async () => {
			const session = buildOwnSession({ status: 'running' })
			const missedLog = buildSessionLog({ sessionId: session.id, id: 10, content: 'missed line' })
			const { app, mockResults } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			// Auth check, session status check (running), missed logs query
			mockResults.selectQueue = [[session], [session], [missedLog]]

			const controller = new AbortController()
			const req = new Request(`http://localhost/api/sessions/${session.id}/logs/stream`, {
				method: 'GET',
				headers: {
					'x-workspace-id': wsId,
					'Last-Event-ID': '5',
				},
				signal: controller.signal,
			})

			const res = await app.request(req)

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toContain('text/event-stream')
			controller.abort()
		})
	})
})
