import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: analyticsRoutes } = await import('../../routes/analytics')

const wsId = '00000000-0000-0000-0000-000000000001'
const memberRow = { actorId: 'test-actor-id' }

describe('Analytics Routes', () => {
	describe('POST /api/analytics', () => {
		it('records an event for a workspace member', async () => {
			const { app, mockResults, calls } = createTestApp(analyticsRoutes, '/api/analytics')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/analytics',
					{
						name: 'menu_opened',
						props: { objectType: 'bet', objectId: 'abc-123' },
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
			expect(await res.json()).toEqual({ recorded: true })
			expect(calls.inserts).toHaveLength(1)
			expect(calls.inserts[0]).toMatchObject({
				workspaceId: wsId,
				actorId: 'test-actor-id',
				name: 'menu_opened',
				props: { objectType: 'bet', objectId: 'abc-123' },
			})
		})

		it('defaults props to an empty object when omitted', async () => {
			const { app, mockResults, calls } = createTestApp(analyticsRoutes, '/api/analytics')
			mockResults.select = [memberRow]
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest('POST', '/api/analytics', { name: 'menu_opened' }, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(202)
			expect(calls.inserts[0]).toMatchObject({ props: {} })
		})

		it('returns 403 when the actor is not a workspace member', async () => {
			const { app, mockResults } = createTestApp(analyticsRoutes, '/api/analytics')
			mockResults.select = []

			const res = await app.request(
				jsonRequest('POST', '/api/analytics', { name: 'menu_opened' }, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(403)
		})

		it('returns 400 when name has invalid characters', async () => {
			const { app } = createTestApp(analyticsRoutes, '/api/analytics')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/analytics',
					{ name: 'bad name with spaces' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when props payload exceeds 4KB', async () => {
			const { app } = createTestApp(analyticsRoutes, '/api/analytics')
			const big = 'x'.repeat(5000)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/analytics',
					{ name: 'menu_opened', props: { big } },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})
	})
})
