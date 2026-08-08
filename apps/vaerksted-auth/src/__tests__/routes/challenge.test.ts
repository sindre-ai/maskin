import { describe, expect, it } from 'vitest'
import { challengeRoute } from '../../routes/challenge'
import { createTestApp } from '../setup'

describe('POST /auth/challenge', () => {
	it('returns a nonce and timestamp with no auth required', async () => {
		const { app } = createTestApp(challengeRoute)
		const res = await app.request('/auth/challenge', { method: 'POST' })
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(typeof body.nonce).toBe('string')
		expect(body.nonce.length).toBeGreaterThan(0)
		expect(typeof body.timestamp).toBe('number')
	})

	it('returns a different nonce on each call', async () => {
		const { app } = createTestApp(challengeRoute)
		const res1 = await app.request('/auth/challenge', { method: 'POST' })
		const res2 = await app.request('/auth/challenge', { method: 'POST' })
		const body1 = await res1.json()
		const body2 = await res2.json()
		expect(body1.nonce).not.toBe(body2.nonce)
	})
})
