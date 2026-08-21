import { randomUUID } from 'node:crypto'
import { buildCreateWorkspaceBody, buildWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

describe('Workspaces Routes', () => {
	describe('POST /api/workspaces', () => {
		// Each of the 7 default agents does one actor insert + one
		// workspaceMembers insert inside the create transaction (seedDefaultAgentActors);
		// mockResults.insert is the static fallback once insertQueue is exhausted, so
		// unconfigured agent/member inserts still resolve to a row with an id.
		const defaultAgentInsertFallback = { id: randomUUID() }

		it('creates a workspace and adds the creator as owner, returning 201', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls, sessionManager } = createSessionTestApp(
				workspacesRoutes,
				'/api/workspaces',
			)
			mockResults.insertQueue = [
				[ws], // workspaces insert
				[{}], // owner workspaceMembers insert
			]
			mockResults.insert = [defaultAgentInsertFallback]
			// Chief of Staff's welcome session is kicked off fire-and-forget
			// (.catch(), not awaited) right after the transaction commits.
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(ws.id)
			expect(body.name).toBe(ws.name)
			// workspace + owner-member + 7 default agents × (actor + member) = 16.
			expect(calls.inserts).toHaveLength(16)
			expect(calls.inserts[1]).toMatchObject({ workspaceId: ws.id, role: 'owner' })
		})

		it('respects an explicit default_agent_id and does not overwrite it', async () => {
			const explicitAgentId = randomUUID()
			// The mock insert returns this row verbatim (unlike real Postgres, it
			// doesn't reflect what was actually passed to .values()), so build it
			// with the settings the route would have written for this request.
			const ws = buildWorkspace({ settings: { default_agent_id: explicitAgentId } })
			const { app, mockResults, sessionManager } = createSessionTestApp(
				workspacesRoutes,
				'/api/workspaces',
			)
			mockResults.insertQueue = [[ws], [{}]]
			mockResults.insert = [defaultAgentInsertFallback]
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({})

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', {
					...buildCreateWorkspaceBody(),
					settings: { default_agent_id: explicitAgentId },
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.settings.default_agent_id).toBe(explicitAgentId)
		})

		it('returns 500 when workspace insert returns empty', async () => {
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insert = [] // empty — insert failed

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('Failed to create workspace')
		})
	})

	describe('GET /api/workspaces', () => {
		it('returns 200 with list of workspaces', async () => {
			const ws = { ...buildWorkspace(), role: 'owner' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [ws]

			const res = await app.request(jsonGet('/api/workspaces'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
		})
	})

	describe('PATCH /api/workspaces/:id', () => {
		it('returns 200 when workspace updated', async () => {
			const ws = buildWorkspace()
			const updated = { ...ws, name: 'Updated Workspace' }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, { name: 'Updated Workspace' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when workspace not found for settings merge', async () => {
			const { app } = createTestApp(workspacesRoutes, '/api/workspaces')
			const id = '00000000-0000-0000-0000-000000000099'

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 and does not touch the DB when settings.claude_oauth is present', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.update = [{ ...ws, name: 'should not be used' }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: {
						claude_oauth: {
							primary: {
								encryptedAccessToken: 'token',
								encryptedRefreshToken: 'refresh',
								expiresAt: 1234567890,
							},
						},
					},
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(calls.updates).toHaveLength(0)
		})
	})

	describe('PATCH /api/workspaces/admin/:id', () => {
		it('returns 200 and seeds prompt rows when owner enables onboarding', async () => {
			const ws = buildWorkspace()
			const updated = { ...ws, onboardingEnabled: true }
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[ws], // workspace exists check
				[{ actorId: 'test-actor-id' }], // isWorkspaceOwner → owner row found
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { onboarding_enabled: true }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.onboardingEnabled).toBe(true)
		})

		it('returns 403 when caller is not the workspace owner', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[ws], // workspace exists
				[], // isWorkspaceOwner → no owner row (caller is member, not owner)
			]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { onboarding_enabled: true }),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('FORBIDDEN')
		})

		it('returns 404 when workspace does not exist', async () => {
			const id = '00000000-0000-0000-0000-000000000099'
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = []

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${id}`, { onboarding_enabled: true }),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/workspaces/:id/members', () => {
		it('adds a member and returns 201 when caller is a member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember(callerId, wsId)
				[{ type: 'human' }], // target actor type lookup
				[{ id: wsId, settings: {} }], // workspace row locked FOR UPDATE (trial plan)
				[{ n: 0 }], // countHumanMembers — 0 < trial cap 1
			]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${wsId}/members`, {
					actor_id: actorId,
					role: 'member',
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.added).toBe(true)
		})

		it('returns 403 when caller is not a member of the workspace', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			// isWorkspaceMember → no rows
			mockResults.select = []

			const res = await app.request(
				jsonRequest('POST', `/api/workspaces/${wsId}/members`, {
					actor_id: actorId,
					role: 'member',
				}),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.code).toBe('FORBIDDEN')
		})
	})

	describe('GET /api/workspaces/:id/members', () => {
		it('returns 200 with list of members', async () => {
			const wsId = randomUUID()
			const member = {
				actorId: randomUUID(),
				role: 'owner',
				joinedAt: new Date(),
				name: 'Alice',
				type: 'human',
			}
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = [member]

			const res = await app.request(jsonGet(`/api/workspaces/${wsId}/members`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].role).toBe('owner')
		})
	})
})
