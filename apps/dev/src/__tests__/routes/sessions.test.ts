import { buildCreateSessionBody, buildSession, buildSessionLog } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp } from '../setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Sessions Routes', () => {
	describe('POST /api/sessions', () => {
		it('creates a session and returns 201', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)

			const res = await app.request(
				jsonRequest('POST', '/api/sessions', buildCreateSessionBody(), {
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
			const { app, sessionManager } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({
						config: { interactive: true },
						entry_agent_role: 'chief-of-staff',
					}),
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(201)
			const createArgs = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(createArgs?.[0]).toBe(wsId)
			expect(createArgs?.[1]?.config).toMatchObject({
				interactive: true,
				entry_agent_role: 'chief-of-staff',
			})
		})

		it('records who started the session so the launch can name the sender', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager, mockResults } = createSessionTestApp(
				sessionsRoutes,
				'/api/sessions',
			)
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)
			mockResults.selectQueue = [[{ name: 'Planner', type: 'agent' }]]

			await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({ config: { interactive: false } }),
					{ 'x-workspace-id': wsId },
				),
			)

			const createArgs = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(createArgs?.[1]?.config).toMatchObject({
				sender: { name: 'Planner', type: 'agent' },
			})
		})

		it('leaves config untouched when entry_agent_role is omitted', async () => {
			const session = buildSession({ workspaceId: wsId })
			const { app, sessionManager } = createSessionTestApp(sessionsRoutes, '/api/sessions')
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(session)

			await app.request(
				jsonRequest(
					'POST',
					'/api/sessions',
					buildCreateSessionBody({ config: { interactive: true } }),
					{ 'x-workspace-id': wsId },
				),
			)

			const createArgs = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(createArgs?.[1]?.config).not.toHaveProperty('entry_agent_role')
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId, currentActivity: 'Running tests' })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId, currentActivity: 'Old activity' })
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
	})

	describe('POST /api/sessions/:id/stop', () => {
		it('returns 200 when session stopped', async () => {
			const session = buildSession({ workspaceId: wsId, status: 'completed' })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId, status: 'paused' })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId, interactive: true, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId, interactive: true, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId, interactive: false, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId, interactive: true, status: 'paused' })
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
			const session = buildSession({ workspaceId: wsId, interactive: true, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId, interactive: true, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId })
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
			const session = buildSession({ workspaceId: wsId, status: 'running' })
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
			const session = buildSession({ workspaceId: wsId, status: 'completed' })
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
			const session = buildSession({ workspaceId: wsId, status: 'failed' })
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
			const session = buildSession({ workspaceId: wsId, status: 'running' })
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
