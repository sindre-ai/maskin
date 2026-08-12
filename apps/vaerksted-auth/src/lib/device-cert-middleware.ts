import { verifyCert, verifyChallenge } from '@maskin/vaerksted-crypto'
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { device } from '../db/schema'
import type { AppEnv } from '../types'

// Challenge-response request signing, per design doc §6 step 4: "the server
// sends a nonce, the device signs {nonce, timestamp} with its private key
// and presents the signature alongside its cert. The verifier checks the
// cert's signature (trusts vaerksted-auth's public key) and the request
// signature (trusts the device's public key from that cert)."
//
// Transport contract (this app's own choice — not specified by the design
// doc): the cert and the per-request challenge signature travel as headers so
// this middleware composes cleanly in front of any route regardless of body
// shape:
//   X-Device-Cert:  JSON-encoded {device_id, identity_id, public_key, expires_at, signature}
//   X-Nonce:        the nonce string issued by POST /auth/challenge
//   X-Timestamp:    unix seconds, must match what was signed
//   X-Signature:    hex signature of {nonce, timestamp}, made with the device's
//                   private key (see @maskin/vaerksted-crypto's signChallenge)

const certSchema = z.object({
	device_id: z.string().uuid(),
	identity_id: z.string().uuid(),
	public_key: z.string(),
	expires_at: z.string(),
	signature: z.string(),
})

// Reject requests whose timestamp is too far from "now" — narrows the replay
// window even though the nonce itself is meant to be single-use (nonce
// tracking/consumption is a vaerksted-sync-relay-level concern per design
// doc §9, not built in this M2 service beyond issuing the nonce).
const TIMESTAMP_FRESHNESS_WINDOW_SECONDS = 5 * 60

/**
 * Verifies a device cert + challenge signature (design doc §6 step 4) and
 * sets `deviceId`/`identityId` in context on success. Mirrors the *shape* of
 * `packages/auth/src/middleware.ts`'s createMiddleware/c.set pattern without
 * importing it (design doc §4).
 */
export function deviceCertMiddleware() {
	return createMiddleware<AppEnv>(async (c, next) => {
		const env = c.get('env')
		if (!env.VAERKSTED_AUTH_SIGNING_PUBLIC_KEY) {
			return c.json(
				{ error: 'server_misconfigured', message: 'VAERKSTED_AUTH_SIGNING_PUBLIC_KEY not set' },
				503,
			)
		}

		const rawCert = c.req.header('X-Device-Cert')
		const nonce = c.req.header('X-Nonce')
		const timestampHeader = c.req.header('X-Timestamp')
		const signature = c.req.header('X-Signature')
		if (!rawCert || !nonce || !timestampHeader || !signature) {
			return c.json(
				{
					error: 'unauthorized',
					message: 'Missing X-Device-Cert, X-Nonce, X-Timestamp, or X-Signature header',
				},
				401,
			)
		}

		const timestamp = Number(timestampHeader)
		if (!Number.isFinite(timestamp)) {
			return c.json({ error: 'unauthorized', message: 'Invalid X-Timestamp header' }, 401)
		}
		const nowSeconds = Date.now() / 1000
		if (Math.abs(nowSeconds - timestamp) > TIMESTAMP_FRESHNESS_WINDOW_SECONDS) {
			return c.json({ error: 'unauthorized', message: 'Timestamp outside freshness window' }, 401)
		}

		let cert: z.infer<typeof certSchema>
		try {
			const parsed = certSchema.safeParse(JSON.parse(rawCert))
			if (!parsed.success) {
				return c.json({ error: 'unauthorized', message: 'Malformed X-Device-Cert' }, 401)
			}
			cert = parsed.data
		} catch {
			return c.json({ error: 'unauthorized', message: 'X-Device-Cert is not valid JSON' }, 401)
		}

		// 1. Cert signature — trusts vaerksted-auth's own public signing key.
		if (!verifyCert(cert, env.VAERKSTED_AUTH_SIGNING_PUBLIC_KEY)) {
			return c.json({ error: 'unauthorized', message: 'Invalid device cert signature' }, 401)
		}

		// 2. Cert expiry — verifyCert intentionally does not check this (see
		// @maskin/vaerksted-crypto's doc comment); it's this caller's job.
		if (new Date(cert.expires_at).getTime() <= Date.now()) {
			return c.json({ error: 'unauthorized', message: 'Device cert has expired' }, 401)
		}

		// 3. Per-request challenge signature — trusts the device's own public
		// key, as attested by the (already-verified) cert.
		if (!verifyChallenge(cert.public_key, signature, nonce, timestamp)) {
			return c.json({ error: 'unauthorized', message: 'Invalid challenge signature' }, 401)
		}

		// 4. Revocation check — design doc §6 step 5: "mark device.revoked_at;
		// certs are short-lived so a revoked device is locked out within one
		// TTL window even if a relay node cached its old cert." A still-valid
		// (unexpired) cert for an already-revoked device must still be
		// rejected here, not just left to expire naturally.
		const db = c.get('db')
		const [deviceRow] = await db.select().from(device).where(eq(device.id, cert.device_id)).limit(1)
		if (!deviceRow || deviceRow.revokedAt !== null) {
			return c.json({ error: 'unauthorized', message: 'Device is revoked or unknown' }, 401)
		}

		c.set('deviceId', cert.device_id)
		c.set('identityId', cert.identity_id)
		return next()
	})
}
