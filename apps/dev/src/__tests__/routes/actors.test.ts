import { randomUUID } from 'node:crypto'
import { PLATFORM_MCP_PRESET, WORKSPACE_COACH_DEFAULT } from '@maskin/shared'
import { buildActor, buildCreateActorBody, buildSession, buildWorkspaceMember } from '../factories'
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

		it('seeds Workspace Coach with a generated apiKey when auto-creating a workspace', async () => {
			const actor = buildActor({ type: 'human' })
			const coach = buildActor({ type: 'agent', name: 'Workspace Coach', isSystem: true })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors')
			mockResults.insertQueue = [
				[actor], // human actor insert (already has apiKey via generateApiKey)
				[{ id: randomUUID(), name: 'ws' }], // workspaces insert
				[{}], // owner workspaceMembers insert
				[coach], // Workspace Coach actor insert — must carry apiKey
				[{}], // Workspace Coach workspaceMembers insert
			]

			const res = await app.request(
				jsonRequest('POST', '/api/actors', buildCreateActorBody({ type: 'human' })),
			)

			expect(res.status).toBe(201)
			// inserts: [actor, workspace, owner-member, coach, coach-member]
			const coachInsert = calls.inserts[3] as { apiKey?: string; isSystem?: boolean }
			expect(coachInsert.isSystem).toBe(true)
			expect(coachInsert.apiKey).toBeDefined()
			expect(coachInsert.apiKey).toMatch(/^ank_/)

			// And it must NOT be the same key as the creator's key
			const creatorInsert = calls.inserts[0] as { apiKey?: string }
			expect(coachInsert.apiKey).not.toBe(creatorInsert.apiKey)
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
			const systemActor = buildActor({ isSystem: true, type: 'agent', name: 'Workspace Coach' })
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

		// PATCH's `.returning({...})` aliases camelCase columns to snake_case in
		// production, but the mock proxy returns whatever shape the test provides.
		// So the mocked update rows below use snake_case keys to mirror what the
		// real handler emits when a route reads back the row it just wrote.
		it('persists avatar_url on the update set and echoes it in the response', async () => {
			const actor = buildActor({ type: 'agent' })
			const avatarUrl = 'https://example.com/avatar.png'
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
			mockResults.select = [{ type: actor.type }]
			mockResults.update = [{ ...actor, avatar_url: avatarUrl }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${actor.id}`, { avatar_url: avatarUrl }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.avatar_url).toBe(avatarUrl)
			expect(calls.updates[0]).toMatchObject({ avatarUrl })
		})

		it('rejects a non-URL avatar_url with 400', async () => {
			const actor = buildActor({ type: 'agent' })
			const { app } = createTestApp(actorsRoutes, '/api/actors', actor.id)

			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${actor.id}`, { avatar_url: 'not-a-url' }),
			)

			expect(res.status).toBe(400)
		})

		it('clears avatar_url when the body sends null', async () => {
			const actor = buildActor({ type: 'agent' })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
			mockResults.select = [{ type: actor.type }]
			mockResults.update = [{ ...actor, avatar_url: null }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${actor.id}`, { avatar_url: null }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.avatar_url).toBeNull()
			expect(calls.updates[0]).toMatchObject({ avatarUrl: null })
		})

		it('leaves avatar_url alone when omitted from the body', async () => {
			const existing = 'https://example.com/keep.png'
			const actor = buildActor({ type: 'agent' })
			const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
			mockResults.select = [{ type: actor.type }]
			mockResults.update = [{ ...actor, name: 'Renamed', avatar_url: existing }]

			const res = await app.request(
				jsonRequest('PATCH', `/api/actors/${actor.id}`, { name: 'Renamed' }),
			)

			expect(res.status).toBe(200)
			expect(calls.updates[0]).not.toHaveProperty('avatarUrl')
			const body = await res.json()
			expect(body.avatar_url).toBe(existing)
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

		it('returns 409 with field error when email already exists', async () => {
			const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors')
			const emailError = Object.assign(
				new Error('duplicate key value violates unique constraint "actors_email_unique"'),
				{ code: '23505', constraint_name: 'actors_email_unique' },
			)
			mockResults.insertError = emailError

			const res = await app.request(
				jsonRequest('POST', '/api/actors', buildCreateActorBody({ type: 'human' })),
			)

			expect(res.status).toBe(409)
			const body = await res.json()
			expect(body.error.message).toBe('Email already exists')
			expect(body.error.details[0].field).toBe('email')
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

		it('returns 200 and restores system_prompt, llm_provider, llm_config, tools for a system actor', async () => {
			const systemActor = buildActor({
				type: 'agent',
				isSystem: true,
				systemPrompt: 'edited prompt',
				llmProvider: 'openai',
				llmConfig: { model: 'gpt-4' },
				tools: { mcpServers: {} },
			})
			// Matches the .returning({ system_prompt: actors.systemPrompt, ... }) shape.
			const resetActor = {
				...systemActor,
				system_prompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
				llm_provider: WORKSPACE_COACH_DEFAULT.llmProvider,
				llm_config: WORKSPACE_COACH_DEFAULT.llmConfig,
				tools: WORKSPACE_COACH_DEFAULT.tools,
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
			expect(body.system_prompt).toBe(WORKSPACE_COACH_DEFAULT.systemPrompt)
			expect(body.llm_provider).toBe(WORKSPACE_COACH_DEFAULT.llmProvider)
			expect(body.llm_config).toEqual(WORKSPACE_COACH_DEFAULT.llmConfig)
			expect(body.tools).toEqual(WORKSPACE_COACH_DEFAULT.tools)
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
				name: 'Workspace Coach',
				email: 'workspace-coach@maskin',
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
				system_prompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
				llm_provider: WORKSPACE_COACH_DEFAULT.llmProvider,
				llm_config: WORKSPACE_COACH_DEFAULT.llmConfig,
				tools: WORKSPACE_COACH_DEFAULT.tools,
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
			expect(body.name).toBe('Workspace Coach')
			expect(body.email).toBe('workspace-coach@maskin')
			expect(body.memory).toEqual({ notes: 'user preference: concise replies' })
		})
	})

	describe('POST /api/actors/:id/pause', () => {
		const wsId = randomUUID()

		it('pauses the agent and any running session', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'running' })
			const runningSession = buildSession({
				actorId: agent.id,
				workspaceId: wsId,
				status: 'running',
			})
			const updated = { ...agent, agentState: 'paused', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			// isWorkspaceMember (requester), actor lookup, isWorkspaceMember (target),
			// live sessions select.
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[runningSession],
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.agentState).toBe('paused')
			expect(sessionManager.pauseSession).toHaveBeenCalledWith(runningSession.id)
		})

		it('pauses the agent with no live session — just sets state', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'idle' })
			const updated = { ...agent, agentState: 'paused', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[], // no live sessions
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.agentState).toBe('paused')
			expect(sessionManager.pauseSession).not.toHaveBeenCalled()
			expect(sessionManager.stopSession).not.toHaveBeenCalled()
		})

		it('stops a non-running live session (e.g. starting) instead of pausing it', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'running' })
			const startingSession = buildSession({
				actorId: agent.id,
				workspaceId: wsId,
				status: 'starting',
			})
			const updated = { ...agent, agentState: 'paused', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[startingSession],
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			expect(sessionManager.stopSession).toHaveBeenCalledWith(startingSession.id)
			expect(sessionManager.pauseSession).not.toHaveBeenCalled()
		})

		it('returns 404 when requester is not a workspace member', async () => {
			const { app } = createSessionTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${randomUUID()}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when target actor is not in the workspace', async () => {
			const agent = buildActor({ type: 'agent' })
			const { app, mockResults } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[], // target not a member
			]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(404)
		})

		it('still pauses the agent even when sessionManager.pauseSession fails', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'running' })
			const runningSession = buildSession({
				actorId: agent.id,
				workspaceId: wsId,
				status: 'running',
			})
			const updated = { ...agent, agentState: 'paused', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[runningSession],
			]
			mockResults.update = [updated]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
				new Error('snapshot failed'),
			)

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.agentState).toBe('paused')
		})

		it('attempts all sessions and still pauses the agent when multiple sessions fail', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'running' })
			const session1 = buildSession({ actorId: agent.id, workspaceId: wsId, status: 'running' })
			const session2 = buildSession({ actorId: agent.id, workspaceId: wsId, status: 'running' })
			const updated = { ...agent, agentState: 'paused', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[session1, session2],
			]
			mockResults.update = [updated]
			;(sessionManager.pauseSession as ReturnType<typeof vi.fn>)
				.mockRejectedValueOnce(new Error('first failed'))
				.mockRejectedValueOnce(new Error('second failed'))

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/pause`, undefined, {
					'x-workspace-id': wsId,
				}),
			)

			// Both sessions were attempted despite failures
			expect(sessionManager.pauseSession).toHaveBeenCalledTimes(2)
			// Actor is still marked paused
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.agentState).toBe('paused')
		})
	})

	describe('POST /api/actors/:id/run', () => {
		const wsId = randomUUID()

		it('starts a fresh session when no paused or running session exists', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'idle' })
			const updated = { ...agent, agentState: 'running', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[], // no live session
				[], // no paused session
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/actors/${agent.id}/run`,
					{ action_prompt: 'Pick up where you left off' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.agentState).toBe('running')
			expect(sessionManager.createSession).toHaveBeenCalledWith(
				wsId,
				expect.objectContaining({
					actorId: agent.id,
					actionPrompt: 'Pick up where you left off',
					createdBy: 'test-actor-id',
				}),
			)
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
		})

		it('uses a default action_prompt when none provided', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'idle' })
			const updated = { ...agent, agentState: 'running', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[],
				[],
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/run`, {}, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const created = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0][1]
			expect(typeof created.actionPrompt).toBe('string')
			expect(created.actionPrompt.length).toBeGreaterThan(0)
		})

		it('resumes the most recent paused session', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'paused' })
			const pausedSession = buildSession({
				actorId: agent.id,
				workspaceId: wsId,
				status: 'paused',
			})
			const updated = { ...agent, agentState: 'running', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[], // no live session
				[pausedSession],
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/run`, {}, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.agentState).toBe('running')
			expect(sessionManager.resumeSession).toHaveBeenCalledWith(pausedSession.id)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('is a no-op for live sessions — does not create or resume', async () => {
			const agent = buildActor({ type: 'agent', agentState: 'running' })
			const liveSession = buildSession({
				actorId: agent.id,
				workspaceId: wsId,
				status: 'running',
			})
			const updated = { ...agent, agentState: 'running', agentStateUpdatedAt: new Date() }
			const { app, mockResults, sessionManager } = createSessionTestApp(actorsRoutes, '/api/actors')
			mockResults.selectQueue = [
				[buildWorkspaceMember({ actorId: 'test-actor-id', workspaceId: wsId })],
				[agent],
				[buildWorkspaceMember({ actorId: agent.id, workspaceId: wsId })],
				[liveSession],
			]
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${agent.id}/run`, {}, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(200)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(sessionManager.resumeSession).not.toHaveBeenCalled()
		})

		it('returns 404 when requester is not a workspace member', async () => {
			const { app } = createSessionTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest('POST', `/api/actors/${randomUUID()}/run`, {}, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(404)
		})

		it('returns 400 with empty action_prompt', async () => {
			const { app } = createSessionTestApp(actorsRoutes, '/api/actors')

			const res = await app.request(
				jsonRequest(
					'POST',
					`/api/actors/${randomUUID()}/run`,
					{ action_prompt: '' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})
})
