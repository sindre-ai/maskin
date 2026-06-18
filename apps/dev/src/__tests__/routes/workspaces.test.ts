import { randomUUID } from 'node:crypto'
import { buildActor, buildCreateWorkspaceBody, buildWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')

describe('Workspaces Routes', () => {
	describe('POST /api/workspaces', () => {
		it('creates a workspace and seeds Sindre + default trio, returning 201', async () => {
			const ws = buildWorkspace()
			const sindre = buildActor({ type: 'agent', name: 'Sindre', isSystem: true })
			const driver = buildActor({ type: 'agent', name: 'Driver', isSystem: true })
			const coach = buildActor({ type: 'agent', name: 'Coach', isSystem: true })
			const strategist = buildActor({ type: 'agent', name: 'Strategist', isSystem: true })
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = [
				[ws], // workspaces insert
				[{}], // owner workspaceMembers insert
				[sindre], // Sindre actor insert
				[{}], // Sindre workspaceMembers insert
				[driver], // Driver actor insert
				[{}], // Driver workspaceMembers insert
				[coach], // Coach actor insert
				[{}], // Coach workspaceMembers insert
				[strategist], // Strategist actor insert
				[{}], // Strategist workspaceMembers insert
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(ws.id)
			expect(body.name).toBe(ws.name)
		})

		it('seeds Sindre with a generated apiKey distinct from the creator', async () => {
			const ws = buildWorkspace()
			const sindre = buildActor({ type: 'agent', name: 'Sindre', isSystem: true })
			const driver = buildActor({ type: 'agent', name: 'Driver', isSystem: true })
			const coach = buildActor({ type: 'agent', name: 'Coach', isSystem: true })
			const strategist = buildActor({ type: 'agent', name: 'Strategist', isSystem: true })
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = [
				[ws],
				[{}],
				[sindre],
				[{}],
				[driver],
				[{}],
				[coach],
				[{}],
				[strategist],
				[{}],
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			// inserts: [workspace, owner-member, sindre-actor, sindre-member, ...trio actors + members]
			const sindreInsert = calls.inserts[2] as { apiKey?: string; type?: string }
			expect(sindreInsert.type).toBe('agent')
			expect(sindreInsert.apiKey).toBeDefined()
			expect(sindreInsert.apiKey).toMatch(/^ank_/)
		})

		it('seats Driver, Coach, Strategist each with isSystem and a distinct apiKey', async () => {
			const ws = buildWorkspace()
			const sindre = buildActor({ type: 'agent', name: 'Sindre', isSystem: true })
			const driver = buildActor({ type: 'agent', name: 'Driver', isSystem: true })
			const coach = buildActor({ type: 'agent', name: 'Coach', isSystem: true })
			const strategist = buildActor({ type: 'agent', name: 'Strategist', isSystem: true })
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = [
				[ws],
				[{}],
				[sindre],
				[{}],
				[driver],
				[{}],
				[coach],
				[{}],
				[strategist],
				[{}],
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			// Trio actor inserts: indexes 4, 6, 8.
			const trioInserts = [calls.inserts[4], calls.inserts[6], calls.inserts[8]] as Array<{
				name?: string
				type?: string
				isSystem?: boolean
				apiKey?: string
			}>
			expect(trioInserts.map((i) => i.name)).toEqual(['Driver', 'Coach', 'Strategist'])
			expect(trioInserts.every((i) => i.type === 'agent')).toBe(true)
			expect(trioInserts.every((i) => i.isSystem === true)).toBe(true)
			const apiKeys = trioInserts.map((i) => i.apiKey)
			expect(apiKeys.every((k) => typeof k === 'string' && k.startsWith('ank_'))).toBe(true)
			expect(new Set(apiKeys).size).toBe(3)
		})

		it('skips trio members already seated on the workspace (idempotent)', async () => {
			const ws = buildWorkspace()
			const sindre = buildActor({ type: 'agent', name: 'Sindre', isSystem: true })
			const strategist = buildActor({ type: 'agent', name: 'Strategist', isSystem: true })
			const { app, mockResults, calls } = createTestApp(workspacesRoutes, '/api/workspaces')
			// The seeder's pre-insert select for existing names returns Driver + Coach
			// already a member, so only Strategist gets inserted.
			mockResults.selectQueue = [[{ name: 'Driver' }, { name: 'Coach' }]]
			mockResults.insertQueue = [
				[ws],
				[{}],
				[sindre],
				[{}],
				[strategist], // Strategist actor insert
				[{}], // Strategist workspaceMembers insert
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(201)
			// inserts: [workspace, owner-member, sindre-actor, sindre-member, strategist-actor, strategist-member]
			expect(calls.inserts).toHaveLength(6)
			const strategistInsert = calls.inserts[4] as { name?: string }
			expect(strategistInsert.name).toBe('Strategist')
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

		it('rolls back and returns 500 when Sindre actor insert returns empty', async () => {
			const ws = buildWorkspace()
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = [
				[ws], // workspaces insert succeeds
				[{}], // owner workspaceMembers insert succeeds
				[], // Sindre actor insert fails — triggers rollback
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(500)
		})

		it('rolls back when a trio actor insert returns empty', async () => {
			const ws = buildWorkspace()
			const sindre = buildActor({ type: 'agent', name: 'Sindre', isSystem: true })
			const { app, mockResults } = createTestApp(workspacesRoutes, '/api/workspaces')
			mockResults.insertQueue = [
				[ws],
				[{}],
				[sindre],
				[{}],
				[], // Driver actor insert fails — should throw and roll back
			]

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', buildCreateWorkspaceBody()),
			)

			expect(res.status).toBe(500)
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
})
