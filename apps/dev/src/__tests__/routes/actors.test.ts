import { randomUUID } from 'node:crypto'
import { PLATFORM_MCP_PRESET, SINDRE_DEFAULT } from '@maskin/shared'
import { buildActor, buildCreateActorBody, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp, createTestApp } from '../setup'

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

		it('seeds Sindre with a generated apiKey when auto-creating a workspace', async () => {
			const actor = buildActor({ type: 'human' })
			const sindre = buildActor({ type: 'agent', name: 'Sindre', isSystem: true })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.insertQueue = [
				[actor], // human actor insert (already has apiKey via generateApiKey)
				[{ id: randomUUID(), name: 'ws' }], // workspaces insert
				[{}], // owner workspaceMembers insert
				[sindre], // Sindre actor insert — must carry apiKey
				[{}], // Sindre workspaceMembers insert
			]

			const res = await app.request(
				jsonRequest('POST', '/api/actors', buildCreateActorBody({ type: 'human' })),
			)

			expect(res.status).toBe(201)
			// inserts: [actor, workspace, owner-member, sindre, sindre-member]
			const sindreInsert = calls.inserts[3] as { apiKey?: string; isSystem?: boolean }
			expect(sindreInsert.isSystem).toBe(true)
			expect(sindreInsert.apiKey).toBeDefined()
			expect(sindreInsert.apiKey).toMatch(/^ank_/)

			// And it must NOT be the same key as the creator's key
			const creatorInsert = calls.inserts[0] as { apiKey?: string }
			expect(sindreInsert.apiKey).not.toBe(creatorInsert.apiKey)
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
			// Without pagination: caller's workspaces, then membership rows.
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
			expect(res.headers.get('x-total-count')).toBe('2')
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
			expect(res.headers.get('x-total-count')).toBe('1')
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
			expect(res.headers.get('x-total-count')).toBe('0')
			const body = await res.json()
			expect(body).toHaveLength(0)
		})

		it('paginates workspace-scoped listing and surfaces total count beyond the page cap', async () => {
			const wsId = '00000000-0000-0000-0000-000000000001'
			const a1 = buildActor({ type: 'human', name: 'Alice', email: null })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// Workspace-scoped paginated path runs two parallel queries: page + count.
			mockResults.selectQueue = [
				[
					{
						id: a1.id,
						type: a1.type,
						name: a1.name,
						email: a1.email,
						isSystem: a1.isSystem,
						role: 'member',
					},
				],
				[{ value: 1234 }],
			]

			const res = await app.request(
				jsonGet('/api/actors?limit=1&offset=0', { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			expect(res.headers.get('x-total-count')).toBe('1234')
			const body = await res.json()
			expect(body).toHaveLength(1)
			expect(body[0].id).toBe(a1.id)
		})

		it('rejects oversized limit query at the boundary', async () => {
			const wsId = '00000000-0000-0000-0000-000000000001'
			const { app } = createTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(jsonGet('/api/actors?limit=999', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(400)
		})

		describe('with ?ids= filter', () => {
			const id1 = '11111111-1111-1111-1111-111111111111'
			const id2 = '22222222-2222-2222-2222-222222222222'
			const wsId = '00000000-0000-0000-0000-000000000001'

			it('returns only the requested actors (workspace-scoped branch)', async () => {
				const a1 = buildActor({ id: id1, type: 'human', name: 'Alice', email: 'a@test.com' })
				const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
				mockResults.select = [{ ...a1, role: 'owner' }]

				const res = await app.request(
					jsonGet(`/api/actors?ids=${id1},${id2}`, { 'x-workspace-id': wsId }),
				)

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body).toHaveLength(1)
				expect(body[0].id).toBe(id1)
			})

			it('returns only the requested actors (cross-workspace branch)', async () => {
				const a1 = buildActor({ id: id1, type: 'human', name: 'Alice', email: 'a@test.com' })
				const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
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
					],
				]

				const res = await app.request(jsonGet(`/api/actors?ids=${id1}`))

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body).toHaveLength(1)
				expect(body[0].id).toBe(a1.id)
			})

			it('returns 400 when ids contains a non-UUID value', async () => {
				const { app } = createTestApp(actorsRoutes, '/api/actors')

				const res = await app.request(jsonGet(`/api/actors?ids=${id1},not-a-uuid`))

				expect(res.status).toBe(400)
			})

			it('returns 400 when ids exceeds the 200 entry cap', async () => {
				const { app } = createTestApp(actorsRoutes, '/api/actors')

				const overflow = Array.from(
					{ length: 201 },
					(_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
				).join(',')
				const res = await app.request(jsonGet(`/api/actors?ids=${overflow}`))

				expect(res.status).toBe(400)
			})

			it('returns an empty list when ids is empty after trimming', async () => {
				const { app } = createTestApp(actorsRoutes, '/api/actors')

				const res = await app.request(jsonGet('/api/actors?ids=,,'))

				expect(res.status).toBe(200)
				const body = await res.json()
				expect(body).toEqual([])
			})
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
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors', actor.id)
			mockResults.select = [{ type: actor.type }]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${actor.id}`, { name: 'Updated Name' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 403 when a non-admin updates another human', async () => {
			const actor = buildActor({ type: 'human' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors', 'caller-id')
			mockResults.selectQueue = [[{ type: actor.type }], [{ role: 'member' }]]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/actors/${actor.id}`,
					{ description: 'Teammate context' },
					{ 'X-Workspace-Id': '00000000-0000-0000-0000-000000000001' },
				),
			)

			expect(res.status).toBe(403)
		})

		it('returns 200 when a workspace admin updates another human in the workspace', async () => {
			const actor = buildActor({ type: 'human' })
			const updated = { ...actor, description: 'Teammate context' }
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors', 'caller-id')
			mockResults.selectQueue = [
				[{ type: actor.type }],
				[{ role: 'admin' }],
				[{ actorId: actor.id }],
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/actors/${actor.id}`,
					{ description: 'Teammate context' },
					{ 'X-Workspace-Id': '00000000-0000-0000-0000-000000000001' },
				),
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
			// actor lookup, isWorkspaceMember (requester), isWorkspaceMember (target),
			// actorSessions in transaction.
			mockResults.selectQueue = [
				[agentActor],
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
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

		it('returns 404 when target actor not found', async () => {
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// actor lookup returns nothing
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonDelete(`/api/actors/${randomUUID()}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when requesting actor is not a workspace member', async () => {
			const agentActor = buildActor({ type: 'agent' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// actor found, isWorkspaceMember (requester) returns empty
			mockResults.selectQueue = [[agentActor], []]

			const res = await app.request(
				jsonDelete(`/api/actors/${agentActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target actor is not in the workspace', async () => {
			const agentActor = buildActor({ type: 'agent' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			// actor found, requester member, target not member
			mockResults.selectQueue = [
				[agentActor],
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
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
			// DELETE: target actor (system → rejected early). Follow-up GET: same row.
			mockResults.selectQueue = [[systemActor], [systemActor]]

			const deleteRes = await app.request(
				jsonDelete(`/api/actors/${systemActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(deleteRes.status).toBe(403)
			const deleteBody = await deleteRes.json()
			expect(deleteBody.error.message).toContain('System actors cannot be deleted')

			const getRes = await app.request(jsonGet(`/api/actors/${systemActor.id}`))

			expect(getRes.status).toBe(200)
			const getBody = await getRes.json()
			expect(getBody.id).toBe(systemActor.id)
		})

		it('returns 403 when a human tries to delete another human account', async () => {
			const humanActor = buildActor({ type: 'human' })
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors', 'caller-id')
			mockResults.selectQueue = [[humanActor]]

			const res = await app.request(
				jsonDelete(`/api/actors/${humanActor.id}`, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
			const body = await res.json()
			expect(body.error.message).toContain('Humans can only delete their own account')
		})
	})

	describe('POST /api/actors/:id/reset', () => {
		const wsId = randomUUID()

		it('returns 200 and restores system_prompt, llm_provider, llm_config, tools for a system actor', async () => {
			const systemActor = buildActor({
				type: 'agent',
				isSystem: true,
				systemPrompt: 'edited prompt',
				llmProvider: 'openai',
				llmConfig: { model: 'gpt-4' },
				tools: { mcpServers: {} },
			})
			// .returning() now returns the full Drizzle row (camelCase columns).
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
			expect(body.system_prompt).toBe(SINDRE_DEFAULT.systemPrompt)
			expect(body.llm_provider).toBe(SINDRE_DEFAULT.llmProvider)
			expect(body.llm_config).toEqual(SINDRE_DEFAULT.llmConfig)
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
			// Drizzle returns the post-update row in the .returning() shape (snake_case).
			const resetActor = {
				...systemActor,
				system_prompt: SINDRE_DEFAULT.systemPrompt,
				llm_provider: SINDRE_DEFAULT.llmProvider,
				llm_config: SINDRE_DEFAULT.llmConfig,
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

	describe('GET /api/actors/:id/avatar', () => {
		it('serves blob with correct Content-Type and cache headers', async () => {
			const actorId = randomUUID()
			const actor = buildActor({ id: actorId, avatarStorageKey: `actors/${actorId}/avatar.jpg` })
			const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
			const { app, mockResults, storageProvider } = createImportTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [actor]
			vi.mocked(storageProvider.get).mockResolvedValue(imageBytes)

			const res = await app.request(
				new Request(`http://localhost/api/actors/${actorId}/avatar`),
			)

			expect(res.status).toBe(200)
			expect(res.headers.get('Content-Type')).toBe('image/jpeg')
			expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
		})

		it('derives image/png content-type for .png storage key', async () => {
			const actorId = randomUUID()
			const actor = buildActor({ id: actorId, avatarStorageKey: `actors/${actorId}/avatar.png` })
			const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
			const { app, mockResults, storageProvider } = createImportTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [actor]
			vi.mocked(storageProvider.get).mockResolvedValue(imageBytes)

			const res = await app.request(
				new Request(`http://localhost/api/actors/${actorId}/avatar`),
			)

			expect(res.status).toBe(200)
			expect(res.headers.get('Content-Type')).toBe('image/png')
		})

		it('returns 404 when actor has no avatar_storage_key', async () => {
			const actor = buildActor({ avatarStorageKey: null })
			const { app, mockResults } = createImportTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [actor]

			const res = await app.request(
				new Request(`http://localhost/api/actors/${actor.id}/avatar`),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when storage.get throws', async () => {
			const actorId = randomUUID()
			const actor = buildActor({ id: actorId, avatarStorageKey: `actors/${actorId}/avatar.png` })
			const { app, mockResults, storageProvider } = createImportTestApp(actorsRoutes, '/api/actors')
			mockResults.select = [actor]
			vi.mocked(storageProvider.get).mockRejectedValue(new Error('blob missing'))

			const res = await app.request(
				new Request(`http://localhost/api/actors/${actorId}/avatar`),
			)

			expect(res.status).toBe(404)
		})
	})
})
