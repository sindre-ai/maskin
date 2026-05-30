import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: analyticsRoutes } = await import('../../routes/analytics')

const wsId = '00000000-0000-0000-0000-000000000001'

describe('Analytics Routes', () => {
	describe('POST /api/analytics', () => {
		it('records an event and returns 202', async () => {
			const { app, mockResults, calls } = createTestApp(analyticsRoutes, '/api/analytics')
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/analytics',
					{
						name: 'menu_opened',
						props: { objectType: 'bet', objectId: 'obj-1' },
						ts: '2026-05-30T12:00:00.000Z',
					},
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
			expect(await res.json()).toEqual({ recorded: true })
			expect(calls.inserts).toHaveLength(1)
			expect(calls.inserts[0]).toEqual({
				workspaceId: wsId,
				actorId: 'test-actor-id',
				name: 'menu_opened',
				props: { objectType: 'bet', objectId: 'obj-1' },
			})
		})

		it('records an event with an empty props object when props is omitted', async () => {
			const { app, mockResults, calls } = createTestApp(analyticsRoutes, '/api/analytics')
			mockResults.insert = [{}]

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/analytics',
					{ name: 'session_restart_clicked' },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(202)
			expect((calls.inserts[0] as { props: unknown }).props).toEqual({})
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

		it('returns 400 when name is missing', async () => {
			const { app } = createTestApp(analyticsRoutes, '/api/analytics')

			const res = await app.request(
				jsonRequest('POST', '/api/analytics', { props: {} }, { 'x-workspace-id': wsId }),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when props exceed the size cap', async () => {
			const { app } = createTestApp(analyticsRoutes, '/api/analytics')
			const big = 'x'.repeat(5000)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/analytics',
					{ name: 'menu_opened', props: { blob: big } },
					{ 'x-workspace-id': wsId },
				),
			)

			expect(res.status).toBe(400)
		})

		it('returns 400 when X-Workspace-Id header is missing', async () => {
			const { app } = createTestApp(analyticsRoutes, '/api/analytics')

			const res = await app.request(jsonRequest('POST', '/api/analytics', { name: 'menu_opened' }))

			expect(res.status).toBe(400)
		})
	})
})
