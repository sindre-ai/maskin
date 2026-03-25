import { buildCreateTriggerBody, buildTrigger } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: triggersRoutes } = await import('../../routes/triggers')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Triggers Routes', () => {
	describe('POST /api/triggers', () => {
		it('creates a trigger and returns 201', async () => {
			const trigger = buildTrigger({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.insert = [trigger]

			const res = await app.request(
				jsonRequest('POST', '/api/triggers', buildCreateTriggerBody(), {
					'x-workspace-id': wsId,
				}),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.id).toBe(trigger.id)
			expect(body.name).toBe(trigger.name)
			expect(body.enabled).toBe(true)
		})
	})

	describe('GET /api/triggers', () => {
		it('returns 200 with list of triggers', async () => {
			const t1 = buildTrigger({ workspaceId: wsId })
			const t2 = buildTrigger({ workspaceId: wsId })
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.select = [t1, t2]

			const res = await app.request(jsonGet('/api/triggers', { 'x-workspace-id': wsId }))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('PATCH /api/triggers/:id', () => {
		it('returns 200 when trigger updated', async () => {
			const trigger = buildTrigger()
			const updated = { ...trigger, name: 'Updated Trigger' }
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.update = [updated]

			const res = await app.request(
				jsonRequest('PATCH', `/api/triggers/${trigger.id}`, { name: 'Updated Trigger' }),
			)

			expect(res.status).toBe(200)
		})

		it('returns 404 when trigger not found', async () => {
			const { app } = createTestApp(triggersRoutes, '/api/triggers')

			const res = await app.request(
				jsonRequest('PATCH', '/api/triggers/00000000-0000-0000-0000-000000000099', {
					name: 'Nope',
				}),
			)

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/triggers/:id', () => {
		it('returns 200 when deleted', async () => {
			const trigger = buildTrigger()
			const { app, mockResults } = createTestApp(triggersRoutes, '/api/triggers')
			mockResults.selectQueue = [[trigger]]

			const res = await app.request(jsonDelete(`/api/triggers/${trigger.id}`))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.deleted).toBe(true)
		})

		it('returns 404 when trigger not found', async () => {
			const { app } = createTestApp(triggersRoutes, '/api/triggers')

			const res = await app.request(
				jsonDelete('/api/triggers/00000000-0000-0000-0000-000000000099'),
			)

			expect(res.status).toBe(404)
		})
	})
})
