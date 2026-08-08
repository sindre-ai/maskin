import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { AppEnv } from '../types'

// POST /auth/challenge — no auth required, identical response shape to
// apps/vaerksted-auth's version (design doc §6 step 4: "the server sends a
// nonce"). vaerksted-sync issues its own nonces rather than delegating back
// to vaerksted-auth (§9: no per-request network call back to vaerksted-auth)
// — the nonce is only ever checked for single-use here, via
// device-cert-middleware.ts's consumeNonce, against this app's own
// consumed_nonce table.
export const challengeRoute = new Hono<AppEnv>()

challengeRoute.post('/auth/challenge', (c) => {
	const nonce = randomBytes(32).toString('hex')
	const timestamp = Math.floor(Date.now() / 1000)
	return c.json({ nonce, timestamp })
})
