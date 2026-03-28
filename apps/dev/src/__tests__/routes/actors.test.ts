import { buildActor, buildCreateActorBody } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
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
})
