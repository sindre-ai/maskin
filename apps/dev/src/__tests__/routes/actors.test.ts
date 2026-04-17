import { randomUUID } from 'node:crypto'
import { SINDRE_DEFAULT } from '@maskin/shared'
import { buildActor, buildCreateActorBody, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: actorsRoutes } = await import('../../routes/actors')

describe('Actors Routes', () => {
	describe('POST /api/actors', () => {
		it('creates a human actor and returns 201', async () => {
			const actor = buildActor()
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// insert returns the created actor
			mockResults.insert = [actor]

			const res = await app.request(jsonRequest('POST', '/api/actors', buildCreateActorBody()))

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(actor.id)
			expect(body.api_key).toBeDefined()
			expect(body.type).toBe('human')
		})

		it('creates an agent actor and returns 201', async () => {
			const actor = buildActor({ type: 'agent' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.insert = [actor]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/actors',
					buildCreateActorBody({
						type: 'agent',
						system_prompt: 'You are a test agent',
						llm_provider: 'anthropic',
					}),
				),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.type).toBe('agent')
		})
	})

	describe('GET /api/actors', () => {
		it('returns 200 with list of actors scoped to shared workspaces', async () => {
			const a1 = { id: buildActor().id, type: 'human', name: 'Alice', email: 'a@test.com' }
			const a2 = { id: buildActor().id, type: 'agent', name: 'Bot', email: null }
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// First select: get workspaces the actor belongs to
			// Second select: get actors in those workspaces
			mockResults.selectQueue = [
				[{ workspaceId: '00000000-0000-0000-0000-000000000001' }],
				[a1, a2],
			]

			const res = await app.request(jsonGet('/api/actors'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})

		it('returns empty list when actor has no workspaces', async () => {
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.select = []

			const res = await app.request(jsonGet('/api/actors'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(0)
		})
	})

	describe('GET /api/actors/:id', () => {
		it('returns 200 when actor found', async () => {
			const actor = buildActor()
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [actor]

			const res = await app.request(jsonGet(`/api/actors/${actor.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.id).toBe(actor.id)
		})

		it('returns 404 when actor not found', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(jsonGet('/api/actors/00000000-0000-0000-0000-000000000099'))

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/actors/:id', () => {
		it('returns 200 when actor updated', async () => {
			const actor = buildActor()
			const updated = { ...actor, name: 'Updated Name' }
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${actor.id}`, { name: 'Updated Name' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when actor not found', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('PATCH', '/api/actors/00000000-0000-0000-0000-000000000099', {
					name: 'Nope',
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/actors/:id/api-keys', () => {
		it('returns 200 with new API key', async () => {
			const actor = buildActor()
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.update = [{ id: actor.id }]

			const res = await app.request(jsonRequest('POST', `/api/actors/${actor.id}/api-keys`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.api_key).toBeDefined()
			expect(body.api_key).toMatch(/^ank_/)
		})

		it('returns 404 when actor not found', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('POST', '/api/actors/00000000-0000-0000-0000-000000000099/api-keys'),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('POST /api/actors - validation', () => {
		it('returns 400 when human actor has no email', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('POST', '/api/actors', {
					type: 'human',
					name: 'No Email',
					password: 'testpassword123',
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Email is required')
		})

		it('returns 400 when human actor has no password', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('POST', '/api/actors', {
					type: 'human',
					name: 'No Password',
					email: 'test@example.com',
				}),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toContain('Password is required')
		})
	})

	describe('GET /api/actors with X-Workspace-Id', () => {
		it('returns workspace members with role field', async () => {
			const wsId = randomUUID()
			const a1 = {
				id: randomUUID(),
				type: 'human',
				name: 'Alice',
				email: 'alice@test.com',
				role: 'owner',
			}
			const a2 = { id: randomUUID(), type: 'agent', name: 'Bot', email: null, role: 'member' }
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// When X-Workspace-Id is provided, the route does an innerJoin query
			mockResults.select = [a1, a2]

			const res = await app.request(jsonGet('/api/actors', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			expect(body[0].role).toBeDefined()
		})
	})

	describe('DELETE /api/actors/:id', () => {
		const wsId = randomUUID()

		it('returns 200 when agent actor deleted successfully', async () => {
			const agentActor = buildActor({ type: 'agent' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// isWorkspaceMember (requester), actor lookup, isWorkspaceMember (target)
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agentActor],
				[buildWorkspaceMember({ actorId: agentActor.id, workspaceId: wsId })],
				[], // actorSessions in transaction
			]

			const res = await app.request(
				jsonDelete(`/api/actors/${agentActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when requesting actor is not a workspace member', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')
			// isWorkspaceMember returns empty — requester not a member

			const res = await app.request(
				jsonDelete(`/api/actors/${randomUUID()}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target actor not found', async () => {
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// isWorkspaceMember (requester) passes, actor lookup fails
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[], // actor not found
			]

			const res = await app.request(
				jsonDelete(`/api/actors/${randomUUID()}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target actor is not in the workspace', async () => {
			const agentActor = buildActor({ type: 'agent' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// isWorkspaceMember (requester) passes, actor found, isWorkspaceMember (target) fails
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agentActor],
				[], // target not a workspace member
			]

			const res = await app.request(
				jsonDelete(`/api/actors/${agentActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 403 when trying to delete a system actor', async () => {
			const systemActor = buildActor({ type: 'agent', isSystem: true })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[systemActor],
				[buildWorkspaceMember({ actorId: systemActor.id, workspaceId: wsId })],
			]

			const res = await app.request(
				jsonDelete(`/api/actors/${systemActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.message).toContain('System agents cannot be deleted')
		})

		it('returns 403 when trying to delete a human actor', async () => {
			const humanActor = buildActor({ type: 'human' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[humanActor],
				[buildWorkspaceMember({ actorId: humanActor.id, workspaceId: wsId })],
			]

			const res = await app.request(
				jsonDelete(`/api/actors/${humanActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.message).toContain('Only agent actors can be deleted')
		})
	})

	describe('POST /api/actors/:id/reset', () => {
		const wsId = randomUUID()

		it('returns 200 and restores systemPrompt, llmProvider, llmConfig, tools for a system actor', async () => {
			const systemActor = buildActor({
				type: 'agent',
				isSystem: true,
				systemPrompt: 'edited prompt',
				llmProvider: 'openai',
				llmConfig: { model: 'gpt-4' },
				tools: { mcpServers: {} },
			})
			const resetActor = {
				...systemActor,
				systemPrompt: SINDRE_DEFAULT.systemPrompt,
				llmProvider: SINDRE_DEFAULT.llmProvider,
				llmConfig: SINDRE_DEFAULT.llmConfig,
				tools: SINDRE_DEFAULT.tools,
			}
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[systemActor],
				[buildWorkspaceMember({ actorId: systemActor.id, workspaceId: wsId })],
			]
			mockResults.update = [resetActor]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${systemActor.id}/reset`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.systemPrompt).toBe(SINDRE_DEFAULT.systemPrompt)
			expect(body.llmProvider).toBe(SINDRE_DEFAULT.llmProvider)
			expect(body.llmConfig).toEqual(SINDRE_DEFAULT.llmConfig)
			expect(body.tools).toEqual(SINDRE_DEFAULT.tools)
		})

		it('returns 403 when the actor is not a system actor', async () => {
			const regularActor = buildActor({ type: 'agent', isSystem: false })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[regularActor],
				[buildWorkspaceMember({ actorId: regularActor.id, workspaceId: wsId })],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${regularActor.id}/reset`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.message).toContain('Only system actors can be reset')
		})

		it('returns 404 when actor does not exist', async () => {
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[], // actor not found
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${randomUUID()}/reset`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when requesting actor is not a workspace member', async () => {
			const { app } = createTestApp(actorsRoutes, '/api/actors')
			// isWorkspaceMember returns empty — requester not a member

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${randomUUID()}/reset`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when the target actor is not in the workspace', async () => {
			const systemActor = buildActor({ type: 'agent', isSystem: true })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[systemActor],
				[], // target not a workspace member
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${systemActor.id}/reset`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})
	})
})
