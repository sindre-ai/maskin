import { randomUUID } from 'node:crypto'
import { buildActor, buildCreateWorkspaceBody, buildWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

// Ordered actor names for the six default agents. Seed inserts run in this order:
// workspaces → owner member → for each agent [actor insert, member insert].
const DEFAULT_AGENT_NAMES = [
	'Workspace Coach',
	'Chief of Staff',
	'Workspace Driver',
	'Strategist',
	'Insights Triage Agent',
	'Research Agent',
] as const

function buildDefaultAgentSeedQueue(ws: ReturnType<typeof buildWorkspace>) {
	const queue: unknown[][] = [
		[ws], // workspaces insert
		[{}], // owner workspaceMembers insert
	]
	for (const name of DEFAULT_AGENT_NAMES) {
		queue.push([buildActor({ type: 'agent', name })]) // actor insert
		queue.push([{}]) // workspaceMembers insert
	}
	return queue
}

describe('Workspaces Routes', () => {
	describe('POST /api/workspaces', () => {
		it('creates a workspace and seeds all 6 default agents, returning 201', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = buildDefaultAgentSeedQueue(ws)

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(ws.id)
			expect(body.name).toBe(ws.name)
		})

		it('seeds every default agent with a generated apiKey and role member', async () => {
			const ws = buildWorkspace()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = buildDefaultAgentSeedQueue(ws)

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			// inserts: [workspace, owner-member, agent1-actor, agent1-member, agent2-actor, ...]
			// The 6 actor inserts are at indices 2, 4, 6, 8, 10, 12.
			const actorInserts = [2, 4, 6, 8, 10, 12].map(
				(i) => calls.inserts[i] as { apiKey?: string; type?: string; name?: string },
			)
			expect(actorInserts.map((a) => a.name)).toEqual([...DEFAULT_AGENT_NAMES])
			for (const insert of actorInserts) {
				expect(insert.type).toBe('agent')
				expect(insert.apiKey).toMatch(/^ank_/)
			}
			// Member roles for the 6 default agents (at 3, 5, 7, 9, 11, 13).
			const memberInserts = [3, 5, 7, 9, 11, 13].map((i) => calls.inserts[i] as { role?: string })
			for (const insert of memberInserts) {
				expect(insert.role).toBe('member')
			}
		})

		it('sets default_agent_id to Chief of Staff when the caller does not specify one', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			const agentRows = DEFAULT_AGENT_NAMES.map((name) => buildActor({ type: 'agent', name }))
			const queue: unknown[][] = [[ws], [{}]]
			for (const row of agentRows) {
				queue.push([row])
				queue.push([{}])
			}
			mockResults.insertQueue = queue

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			const chief = agentRows.find((a) => a.name === 'Chief of Staff')
			expect(body.settings.default_agent_id).toBe(chief?.id)
		})

		it('respects an explicit default_agent_id and does not overwrite it', async () => {
			const explicitAgentId = randomUUID()
			// The mock insert returns this row verbatim (unlike real Postgres, it
			// doesn't reflect what was actually passed to .values()), so build it
			// with the settings the route would have written for this request.
			const ws = buildWorkspace({ settings: { default_agent_id: explicitAgentId } })
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = buildDefaultAgentSeedQueue(ws)

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

		it('rolls back and returns 500 naming the failing agent when a seed insert fails', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = [
				[ws], // workspaces insert succeeds
				[{}], // owner workspaceMembers insert succeeds
				[], // first default-agent actor insert returns empty — triggers rollback
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			// The response names the failing agent and the underlying error class,
			// not a generic "failed to create workspace" message.
			expect(body.error.message).toContain('workspace_coach')
			expect(body.error.details).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ field: 'agent_id', message: 'workspace_coach' }),
					expect.objectContaining({ field: 'error_class' }),
				]),
			)
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
			// isWorkspaceMember(callerId, wsId) → one row (caller is a member)
			mockResults.selectQueue = [[{ actorId: 'test-actor-id' }]]
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

	describe('PATCH /api/workspaces/:id/members/:actorId', () => {
		it("changes a member's role and returns 200", async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember(caller)
				[{ role: 'member' }], // existing member row lookup
			]
			mockResults.update = [{ actorId, role: 'admin', joinedAt: new Date() }]
			// After update, the route re-fetches the actor for name/type.
			// selectQueue is exhausted, so the static `select` supplies the actor row.
			mockResults.select = [{ name: 'Alice', type: 'human' }]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.role).toBe('admin')
			expect(calls.updates[0]).toEqual({ role: 'admin' })
		})

		it('returns 403 when caller is not a member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = []

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(403)
		})

		it('returns 404 when the target member does not exist', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[], // existing member lookup — no row
			]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 when demoting the only owner', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[{ role: 'owner' }], // existing member is the owner
				[{ actorId }], // owner count = 1 → last owner guard trips
			]

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${wsId}/members/${actorId}`, { role: 'admin' }),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
			expect(calls.updates).toHaveLength(0)
		})
	})

	describe('DELETE /api/workspaces/:id/members/:actorId', () => {
		it('removes a member and returns 200', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[{ role: 'member' }], // existing member row
			]
			mockResults.delete = [{ actorId }]
			mockResults.insert = [{}]

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${actorId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.removed).toBe(true)
		})

		it('returns 403 when caller is not a member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.select = []

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${actorId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(403)
		})

		it('returns 400 when removing the only owner', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.selectQueue = [
				[{ actorId: 'test-actor-id' }], // isWorkspaceMember
				[{ role: 'owner' }], // existing member is the owner
				[{ actorId }], // owner count = 1
			]

			const res = await app.request(
				new Request(`http://localhost/api/workspaces/${wsId}/members/${actorId}`, {
					method: 'DELETE',
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('BAD_REQUEST')
		})
	})
})
