import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { AppEnv } from '../types'

// POST /auth/challenge — no auth required (design doc §6 step 4: "the server
// sends a nonce"). This is the first half of the challenge-response
// handshake; the caller signs {nonce, timestamp} with its device private key
// and presents that signature (plus its device cert) on the actual request,
// verified by device-cert-middleware.ts.
//
// Nonce single-use tracking (rejecting a replayed nonce) is intentionally
// NOT implemented here — device-cert-middleware.ts's timestamp-freshness
// check bounds the replay window, and full nonce-consumption bookkeeping is
// a relay-level (vaerksted-sync, M4) concern once there's a natural place to
// store consumed nonces with TTL cleanup. Documented as a deliberate scope
// cut for M2, not an oversight.
export const challengeRoute = new Hono<AppEnv>()

challengeRoute.post('/auth/challenge', (c) => {
	const nonce = randomBytes(32).toString('hex')
	const timestamp = Math.floor(Date.now() / 1000)
	return c.json({ nonce, timestamp })
})
