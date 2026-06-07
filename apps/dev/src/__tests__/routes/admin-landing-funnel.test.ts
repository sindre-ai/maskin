import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import adminLandingFunnelRoutes from '../../routes/admin-landing-funnel'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

describe('GET /api/admin/landing-funnel', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns kill metric + unique-guest denominator with defaults', async () => {
		const { app, mockResults } = createTestApp(
			adminLandingFunnelRoutes,
			'/api/admin/landing-funnel',
		)
		mockResults.selectQueue = [
			[{ total: 100, malformed: 5 }], // kill-window aggregate
			[{ uniqueGuests: 73 }], // success-window unique guests
		]

		const res = await app.request(jsonGet('/api/admin/landing-funnel'))
		expect(res.status).toBe(200)

		const body = (await res.json()) as {
			killMetric: {
				windowHours: number
				totalDrafts: number
				malformedDrafts: number
				malformedRate: number
				threshold: number
				breached: boolean
			}
			successMetric: {
				windowDays: number
				uniqueGuests: number
				signupsFromGuests: number | null
				conversionRate: number | null
				threshold: number
			}
			generatedAt: string
		}

		expect(body.killMetric.windowHours).toBe(48)
		expect(body.killMetric.totalDrafts).toBe(100)
		expect(body.killMetric.malformedDrafts).toBe(5)
		expect(body.killMetric.malformedRate).toBeCloseTo(0.05, 5)
		expect(body.killMetric.threshold).toBe(0.1)
		expect(body.killMetric.breached).toBe(false)

		expect(body.successMetric.windowDays).toBe(7)
		expect(body.successMetric.uniqueGuests).toBe(73)
		expect(body.successMetric.signupsFromGuests).toBeNull()
		expect(body.successMetric.conversionRate).toBeNull()
		expect(body.successMetric.threshold).toBe(0.15)

		expect(typeof body.generatedAt).toBe('string')
	})

	it('flags the kill metric as breached when malformed rate hits 10% with enough samples', async () => {
		const { app, mockResults } = createTestApp(
			adminLandingFunnelRoutes,
			'/api/admin/landing-funnel',
		)
		mockResults.selectQueue = [
			[{ total: 50, malformed: 6 }], // 12% malformed, well above sample floor
			[{ uniqueGuests: 30 }],
		]
		const res = await app.request(jsonGet('/api/admin/landing-funnel'))
		const body = (await res.json()) as {
			killMetric: { malformedRate: number; breached: boolean }
		}
		expect(body.killMetric.malformedRate).toBeCloseTo(0.12, 5)
		expect(body.killMetric.breached).toBe(true)
	})

	it('does not flag breached on tiny samples even if the rate is high', async () => {
		const { app, mockResults } = createTestApp(
			adminLandingFunnelRoutes,
			'/api/admin/landing-funnel',
		)
		mockResults.selectQueue = [
			[{ total: 5, malformed: 3 }], // 60% but only 5 drafts — too small to act on
			[{ uniqueGuests: 4 }],
		]
		const res = await app.request(jsonGet('/api/admin/landing-funnel'))
		const body = (await res.json()) as {
			killMetric: { malformedRate: number; breached: boolean }
		}
		expect(body.killMetric.malformedRate).toBeCloseTo(0.6, 5)
		expect(body.killMetric.breached).toBe(false)
	})

	it('handles an empty drafts window cleanly', async () => {
		const { app, mockResults } = createTestApp(
			adminLandingFunnelRoutes,
			'/api/admin/landing-funnel',
		)
		mockResults.selectQueue = [[{ total: 0, malformed: 0 }], [{ uniqueGuests: 0 }]]
		const res = await app.request(jsonGet('/api/admin/landing-funnel'))
		const body = (await res.json()) as {
			killMetric: { totalDrafts: number; malformedRate: number; breached: boolean }
			successMetric: { uniqueGuests: number }
		}
		expect(body.killMetric.totalDrafts).toBe(0)
		expect(body.killMetric.malformedRate).toBe(0)
		expect(body.killMetric.breached).toBe(false)
		expect(body.successMetric.uniqueGuests).toBe(0)
	})

	it('honors windowHours and successWindowDays from query params', async () => {
		const { app, mockResults } = createTestApp(
			adminLandingFunnelRoutes,
			'/api/admin/landing-funnel',
		)
		mockResults.selectQueue = [[{ total: 10, malformed: 0 }], [{ uniqueGuests: 8 }]]
		const res = await app.request(
			jsonGet('/api/admin/landing-funnel?windowHours=24&successWindowDays=14'),
		)
		const body = (await res.json()) as {
			killMetric: { windowHours: number }
			successMetric: { windowDays: number }
		}
		expect(body.killMetric.windowHours).toBe(24)
		expect(body.successMetric.windowDays).toBe(14)
	})

	it('rejects nonsense windowHours with 400 VALIDATION_ERROR', async () => {
		const { app } = createTestApp(adminLandingFunnelRoutes, '/api/admin/landing-funnel')
		const res = await app.request(jsonGet('/api/admin/landing-funnel?windowHours=99999'))
		expect(res.status).toBe(400)
		const body = (await res.json()) as { error: { code: string } }
		expect(body.error.code).toBe('VALIDATION_ERROR')
	})
})
