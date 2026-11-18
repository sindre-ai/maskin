import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signEmailStopToken } from '../../lib/email-stop-token'
import emailStopRoutes from '../../routes/email-stop'

const SECRET = 'unit-test-email-stop-secret-0123456789abcdef'
const ACTOR = '3f1c1d7e-9a2b-4c55-8d0e-0a1b2c3d4e5f'

// No database is set on the context: a retired link must answer without touching it.
const app = new Hono()
app.route('/api/email/stop', emailStopRoutes)

describe('email stop route: old per-notification links', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', SECRET)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it.each(['needs_you', 'conversation', 'tips'])(
		'a %s link opens a done page and POST changes nothing',
		async (kind) => {
			const token = signEmailStopToken(ACTOR, Date.now(), kind)

			const page = await app.request(`/api/email/stop?token=${token}`)
			expect(page.status).toBe(200)
			const html = await page.text()
			expect(html).toContain('Emails stopped')
			expect(html).not.toContain('<form')

			const post = await app.request(`/api/email/stop?token=${token}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: 'List-Unsubscribe=One-Click',
			})
			expect(post.status).toBe(200)
			expect(await post.text()).toContain('Emails stopped')
		},
	)

	it('a changed old link is still refused', async () => {
		const token = signEmailStopToken(ACTOR, Date.now(), 'tips')
		const res = await app.request(`/api/email/stop?token=${token}x`)
		expect(res.status).toBe(400)
	})

	it('a flow activity link still asks before it stops anything', async () => {
		const token = signEmailStopToken(ACTOR, Date.now(), 'flow_activity')
		const res = await app.request(`/api/email/stop?token=${token}`)
		expect(res.status).toBe(200)
		expect(await res.text()).toContain('Stop flow activity emails?')
	})
})
