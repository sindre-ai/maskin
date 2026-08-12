import { verifyCert, verifyChallenge } from '@maskin/vaerksted-crypto'
import { lt } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { consumedNonce } from '../db/schema'
import type { AppEnv } from '../types'

// Challenge-response request signing, per design doc §6 step 4 — adapted
// from apps/vaerksted-auth/src/lib/device-cert-middleware.ts with two
// deliberate differences (see the M4 task spec this was built against):
//
// 1. No revocation DB check. vaerksted-sync has no `device` table (different
//    service/schema entirely) and, per design doc §6 step 5 and §9 ("it
//    authenticates callers via device certs from vaerksted-auth — it does
//    not run its own login flow"), must not call back to vaerksted-auth per
//    request. Revocation here is enforced purely by cert expiry +
//    non-renewal, exactly as §6 step 5 describes for any relay node.
// 2. Real nonce single-use tracking (see consumeNonce below) — vaerksted-
//    auth's challenge.ts explicitly defers this bookkeeping to "a relay-level
//    (vaerksted-sync, M4) concern." This is that concern.
//
// Transport contract is identical to vaerksted-auth's version — headers
// travel alongside the request regardless of body shape, and (for the WS
// route) alongside the upgrade request:
//   X-Device-Cert:  JSON-encoded {device_id, identity_id, public_key, expires_at, signature}
//   X-Nonce:        the nonce string issued by this app's own POST /auth/challenge
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

// Reject requests whose timestamp is too far from "now" — same window as
// vaerksted-auth's version. Also doubles as the consumed-nonce retention
// window (see consumeNonce's comment below): a nonce older than this window
// could never be presented with a validly-signed, still-fresh timestamp
// anyway, so purging consumed_nonce rows once they age past it is safe.
const TIMESTAMP_FRESHNESS_WINDOW_SECONDS = 5 * 60

/**
 * Marks `nonce` as consumed, rejecting replay. Returns `true` if this is the
 * nonce's first use (request may proceed), `false` if it was already
 * consumed (reject with 401).
 *
 * Best-effort cleanup: deletes consumed_nonce rows older than the freshness
 * window on every insert attempt, rather than running a separate scheduled
 * job — simple and sufficient for M4 (see design doc's exact wire contract:
 * "keep it simple, this doesn't need to be sophisticated for M4"). A replayed
 * request's signature covers {nonce, timestamp} jointly, so a replay's
 * timestamp is always the original, genuinely-signed one — which must have
 * already passed the freshness check when first used. A nonce that ages out
 * of this table can therefore never be legitimately replayed regardless.
 */
async function consumeNonce(
	db: AppEnv['Variables']['db'],
	nonce: string,
): Promise<{ ok: true } | { ok: false }> {
	const cutoff = new Date(Date.now() - TIMESTAMP_FRESHNESS_WINDOW_SECONDS * 1000)
	await db.delete(consumedNonce).where(lt(consumedNonce.consumedAt, cutoff))

	try {
		await db.insert(consumedNonce).values({ nonce })
		return { ok: true }
	} catch (err) {
		// 23505 = unique_violation (Postgres) — the nonce was already consumed.
		// drizzle-orm@0.45's postgres-js driver wraps the raw postgres error in
		// a DrizzleQueryError, putting the actual `.code` on `err.cause`, not
		// `err` itself — checking both keeps this correct across the mock-DB
		// harness (which throws plain Errors with `.code` set directly, see
		// __tests__/setup.ts's `insertError`) and the real driver.
		const code =
			(err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
		if (code === '23505') {
			return { ok: false }
		}
		throw err
	}
}

/**
 * Verifies a device cert + challenge signature (design doc §6 step 4) and
 * sets `deviceId`/`identityId` in context on success. Usable both as normal
 * route middleware and in front of the GET /sync/ws upgrade route — see
 * routes/ws.ts's comment on why that composition authenticates the upgrade
 * request itself, before the socket is accepted.
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

		// 4. Nonce single-use — this is vaerksted-sync's own concern (see file
		// header comment); no revocation DB check happens here (also see file
		// header — that's the other deliberate difference from vaerksted-auth's
		// version).
		const db = c.get('db')
		const nonceResult = await consumeNonce(db, nonce)
		if (!nonceResult.ok) {
			return c.json({ error: 'unauthorized', message: 'Nonce already used (replay)' }, 401)
		}

		c.set('deviceId', cert.device_id)
		c.set('identityId', cert.identity_id)
		return next()
	})
}
