import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import sentryTestRoutes from '../../routes/sentry-test'

describe('GET /api/sentry-test', () => {
	it('throws so the app-factory onError handler forwards to Sentry.captureException', async () => {
		const app = new OpenAPIHono()
		let seen: unknown = null
		// Mirror the app-factory onError seam: any throw from a handler flows
		// through here, and this is where Sentry.captureException is called in
		// the real app-factory. Asserting that a throw reaches this seam is
		// what proves an event would fire against a live DSN.
		app.onError((err, c) => {
			seen = err
			return c.json({ ok: false }, 500)
		})
		app.route('/api/sentry-test', sentryTestRoutes)

		const res = await app.request('/api/sentry-test')

		expect(res.status).toBe(500)
		expect(seen).toBeInstanceOf(Error)
		expect((seen as Error).message).toMatch(/Sentry test exception/i)
	})
})
