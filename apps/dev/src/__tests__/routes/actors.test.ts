import { randomUUID } from 'node:crypto'
import { PLATFORM_MCP_PRESET, SINDRE_DEFAULT } from '@maskin/shared'
import type { Mock } from 'vitest'
import { buildActor, buildCreateActorBody, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

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

		it('defaults the Maskin MCP into tools when creating an agent without tools', async () => {
			const actor = buildActor({ type: 'agent' })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.insert = [actor]

			const res = await app.request(
				jsonRequest('POST', '/api/actors', buildCreateActorBody({ type: 'agent' })),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { tools?: { mcpServers: Record<string, unknown> } }
			expect(inserted.tools?.mcpServers.maskin).toEqual(PLATFORM_MCP_PRESET)
		})

		it('preserves a caller-provided maskin MCP entry over the default', async () => {
			const actor = buildActor({ type: 'agent' })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.insert = [actor]
			const custom = { type: 'http' as const, url: 'https://custom/mcp', headers: {} }

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/actors',
					buildCreateActorBody({
						type: 'agent',
						tools: { mcpServers: { maskin: custom } },
					}),
				),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as {
				tools?: { mcpServers: { maskin: { url: string } } }
			}
			expect(inserted.tools?.mcpServers.maskin.url).toBe('https://custom/mcp')
		})

		it('does not default tools when creating a human actor', async () => {
			const actor = buildActor({ type: 'human' })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.insert = [actor]

			const res = await app.request(
				jsonRequest('POST', '/api/actors', buildCreateActorBody({ type: 'human' })),
			)

			expect(res.status).toBe(201)
			const inserted = calls.inserts[0] as { tools?: unknown }
			expect(inserted.tools).toBeUndefined()
		})
	})

	describe('GET /api/actors', () => {
		it('returns 200 with list of actors annotated with workspace memberships', async () => {
			const a1 = buildActor({ type: 'human', name: 'Alice', email: 'a@test.com' })
			const a2 = buildActor({ type: 'agent', name: 'Bot', email: null })
			const wsId = '00000000-0000-0000-0000-000000000001'
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// First select: get workspaces the actor belongs to
			// Second select: get (actor, workspace, role) rows
			mockResults.selectQueue = [
				[{ workspaceId: wsId }],
				[
					{
						id: a1.id,
						type: a1.type,
						name: a1.name,
						email: a1.email,
						workspaceId: wsId,
						workspaceName: 'Acme',
						role: 'owner',
					},
					{
						id: a2.id,
						type: a2.type,
						name: a2.name,
						email: a2.email,
						workspaceId: wsId,
						workspaceName: 'Acme',
						role: 'member',
					},
				],
			]

			const res = await app.request(jsonGet('/api/actors'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
			expect(body[0].workspaces).toEqual([{ id: wsId, name: 'Acme', role: 'owner' }])
			expect(body[1].workspaces).toEqual([{ id: wsId, name: 'Acme', role: 'member' }])
		})

		it('groups workspace memberships per actor when an actor belongs to multiple workspaces', async () => {
			const actor = buildActor({ type: 'agent', name: 'Bot', email: null })
			const ws1 = '00000000-0000-0000-0000-000000000001'
			const ws2 = '00000000-0000-0000-0000-000000000002'
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[{ workspaceId: ws1 }, { workspaceId: ws2 }],
				[
					{
						id: actor.id,
						type: actor.type,
						name: actor.name,
						email: actor.email,
						workspaceId: ws1,
						workspaceName: 'Acme',
						role: 'member',
					},
					{
						id: actor.id,
						type: actor.type,
						name: actor.name,
						email: actor.email,
						workspaceId: ws2,
						workspaceName: 'Beta',
						role: 'owner',
					},
				],
			]

			const res = await app.request(jsonGet('/api/actors'))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].workspaces).toEqual([
				{ id: ws1, name: 'Acme', role: 'member' },
				{ id: ws2, name: 'Beta', role: 'owner' },
			])
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

		it('exposes is_system field on the response', async () => {
			const systemActor = buildActor({ isSystem: true, type: 'agent', name: 'Sindre' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [systemActor]

			const res = await app.request(jsonGet(`/api/actors/${systemActor.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.isSystem).toBe(true)
		})

		it('exposes isSystem=false for non-system actors', async () => {
			const actor = buildActor()
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [actor]

			const res = await app.request(jsonGet(`/api/actors/${actor.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.isSystem).toBe(false)
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

		it('returns 403 when trying to delete a system actor and leaves the actor intact', async () => {
			const systemActor = buildActor({ type: 'agent', isSystem: true })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// DELETE: requester member, target actor, target member.
			// Follow-up GET: same actor row — proves the record was not removed.
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[systemActor],
				[buildWorkspaceMember({ actorId: systemActor.id, workspaceId: wsId })],
				[systemActor],
			]

			const deleteRes = await app.request(
				jsonDelete(`/api/actors/${systemActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(deleteRes.status).toBe(403)
			const deleteBody = await deleteRes.json()
			expect(deleteBody.error.message).toContain('System agents cannot be deleted')

			const getRes = await app.request(jsonGet(`/api/actors/${systemActor.id}`))

			expect(getRes.status).toBe(200)
			const getBody = await getRes.json()
			expect(getBody.id).toBe(systemActor.id)
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

		it('returns the full updated actor row with identity and memory fields preserved', async () => {
			const systemActor = buildActor({
				type: 'agent',
				name: 'Sindre',
				email: 'sindre@maskin',
				isSystem: true,
				systemPrompt: 'edited prompt',
				llmProvider: 'openai',
				llmConfig: { model: 'gpt-4' },
				tools: { mcpServers: {} },
				memory: { notes: 'user preference: concise replies' },
			})
			// Drizzle returns the post-update row; memory and identity must be preserved.
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
			expect(body.id).toBe(systemActor.id)
			expect(body.type).toBe('agent')
			expect(body.name).toBe('Sindre')
			expect(body.email).toBe('sindre@maskin')
			expect(body.memory).toEqual({ notes: 'user preference: concise replies' })
		})
	})

	describe('POST /api/actors/:id/health-check', () => {
		it('returns 200 and the health result when called by a workspace member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
			]
			;(sessionManager.healthCheck as Mock).mockResolvedValue({
				healthy: true,
				issues: [],
			})

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/health-check`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.healthy).toBe(true)
			expect(body.issues).toEqual([])
			expect(sessionManager.healthCheck).toHaveBeenCalledWith(actorId, wsId)
		})

		it('returns the list of issues when the agent is unhealthy', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[buildWorkspaceMember({ actorId, workspaceId: wsId })],
			]
			;(sessionManager.healthCheck as Mock).mockResolvedValue({
				healthy: false,
				issues: ['No LLM credentials available', "Base image 'agent-base:latest' is missing"],
			})

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/health-check`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.healthy).toBe(false)
			expect(body.issues).toHaveLength(2)
		})

		it('returns 404 when caller is not a workspace member', async () => {
			const wsId = randomUUID()
			const actorId = randomUUID()
			const { app, mockResults } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [[]] // not a member

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${actorId}/health-check`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target actor belongs to a different workspace than the caller', async () => {
			const callerWsId = randomUUID()
			const targetActorId = randomUUID()
			const { app, mockResults, sessionManager } = createSessionTestApp(
				actorsRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [
				// caller is a member of WS-A
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: callerWsId })],
				// target actor is NOT a member of WS-A
				[],
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${targetActorId}/health-check`, undefined, {
					'x-workspace-id': callerWsId,
				}),
			)

			expect(res.status).toBe(404)
			expect(sessionManager.healthCheck).not.toHaveBeenCalled()
		})
	})
})
