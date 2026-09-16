/**
 * Unipile v2 webhook signature verification.
 *
 * Unipile signs every webhook delivery with the endpoint's per-endpoint
 * `secret` (returned by `POST /v2/webhooks/endpoints/` at create time, and
 * viewable in the Unipile dashboard). The signature is delivered in the
 * `unipile-signature` HTTP header as:
 *
 *   unipile-signature: t=<unix-seconds>,v0=<hex-hmac-sha256>
 *
 * where
 *
 *   v0 = HMAC_SHA256(secret, `${t}.${rawBody}`).toString('hex')
 *
 * Docs: https://developer.unipile.com/v2.0/docs/configure-a-webhook#signature-header
 *
 * The signature MUST be verified against the exact raw request body bytes,
 * not against a parsed-then-reserialised JSON — whitespace, key ordering
 * and escaping all matter.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Max clock skew between Unipile's `t` and our clock, in seconds. Unipile
 * doesn't publish an exact tolerance; 5 minutes matches the Stripe/GitHub
 * convention and is tight enough to make replay attacks impractical while
 * loose enough to survive small VM clock drift.
 */
export const UNIPILE_SIGNATURE_MAX_AGE_SEC = 300

export type UnipileSignatureRejection =
	| 'missing-header'
	| 'malformed-header'
	| 'timestamp-out-of-window'
	| 'signature-mismatch'

export type UnipileSignatureResult = { ok: true } | { ok: false; reason: UnipileSignatureRejection }

/**
 * Verify a Unipile v2 webhook signature.
 *
 * Pure function — takes the raw body string, the header value and the
 * endpoint secret, returns `{ ok }` or `{ ok: false, reason }` so the
 * caller can log the specific rejection cause without leaking it to the
 * responder.
 *
 * @param rawBody the exact bytes of the POST body as received on the wire
 * @param header the value of the `unipile-signature` header (any casing)
 * @param secret the per-endpoint secret Unipile returned at endpoint
 *   creation (`wes_...`)
 * @param nowMs current unix time in ms; parameterised only so tests can
 *   pin the clock — production always passes `Date.now()`
 */
export function verifyUnipileWebhookSignature(
	rawBody: string,
	header: string | undefined | null,
	secret: string,
	nowMs: number = Date.now(),
): UnipileSignatureResult {
	if (!header) return { ok: false, reason: 'missing-header' }

	const parts = parseSignatureHeader(header)
	if (!parts) return { ok: false, reason: 'malformed-header' }
	const { t, v0 } = parts

	const nowSec = Math.floor(nowMs / 1000)
	if (Math.abs(nowSec - t) > UNIPILE_SIGNATURE_MAX_AGE_SEC) {
		return { ok: false, reason: 'timestamp-out-of-window' }
	}

	const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
	const expectedBuf = Buffer.from(expected, 'utf8')
	const presentedBuf = Buffer.from(v0, 'utf8')
	if (expectedBuf.length !== presentedBuf.length) {
		return { ok: false, reason: 'signature-mismatch' }
	}
	if (!timingSafeEqual(expectedBuf, presentedBuf)) {
		return { ok: false, reason: 'signature-mismatch' }
	}
	return { ok: true }
}

/**
 * Parse the `unipile-signature` header value into its `t` (unix seconds)
 * and `v0` (hex HMAC) parts. Returns `null` on any structural problem so
 * the caller can lump every malformed-header case into one rejection kind.
 *
 * Accepts extra unknown kv-pairs (Unipile could introduce a `v1` etc.
 * later without breaking us) provided `t` and `v0` are both present and
 * well-formed.
 */
function parseSignatureHeader(header: string): { t: number; v0: string } | null {
	let t: number | undefined
	let v0: string | undefined
	for (const rawPart of header.split(',')) {
		const part = rawPart.trim()
		const eq = part.indexOf('=')
		if (eq <= 0) return null
		const key = part.slice(0, eq).trim()
		const value = part.slice(eq + 1).trim()
		if (key === 't') {
			if (!/^\d+$/.test(value)) return null
			t = Number.parseInt(value, 10)
		} else if (key === 'v0') {
			if (!/^[0-9a-f]+$/i.test(value)) return null
			v0 = value.toLowerCase()
		}
	}
	if (t === undefined || v0 === undefined) return null
	return { t, v0 }
}
