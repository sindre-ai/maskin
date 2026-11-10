import { createHmac, timingSafeEqual } from 'node:crypto'

// Signed token for the "stop these emails" link in a summary email. The link has to work with
// nobody signed in, so the token is the only credential: an HMAC over the account id, the purpose
// and an expiry, keyed by EMAIL_STOP_LINK_SECRET. It can switch email off for that one account and
// do nothing else. Stateless, so no table; switching off twice is harmless.

export const EMAIL_STOP_PURPOSE = 'email_stop'

/** A link in an old email stays usable this long; every new email carries a fresh one. */
export const EMAIL_STOP_TTL_MS = 180 * 24 * 60 * 60 * 1000

const MIN_SECRET_LENGTH = 32
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The signing secret, or null when it is missing or too short. A missing secret never signs or accepts. */
export function secret(): string | null {
	const raw = process.env.EMAIL_STOP_LINK_SECRET?.trim()
	return raw && raw.length >= MIN_SECRET_LENGTH ? raw : null
}

export function isEmailStopConfigured(): boolean {
	return secret() !== null
}

function sign(key: string, actorId: string, expiresAt: number): string {
	return createHmac('sha256', key)
		.update(`${EMAIL_STOP_PURPOSE}:${actorId}:${expiresAt}`)
		.digest('base64url')
}

/** `<account id>.<expiry in ms>.<signature>`. Throws when the secret is not set. */
export function signEmailStopToken(actorId: string, now = Date.now()): string {
	const key = secret()
	if (!key) throw new Error('EMAIL_STOP_LINK_SECRET is not set')
	const id = actorId.toLowerCase()
	const expiresAt = now + EMAIL_STOP_TTL_MS
	return `${id}.${expiresAt}.${sign(key, id, expiresAt)}`
}

export type EmailStopVerdict =
	| { ok: true; actorId: string }
	| { ok: false; reason: 'unconfigured' | 'invalid' | 'expired' }

export function verifyEmailStopToken(token: string, now = Date.now()): EmailStopVerdict {
	const key = secret()
	if (!key) return { ok: false, reason: 'unconfigured' }
	const parts = token.split('.')
	if (parts.length !== 3) return { ok: false, reason: 'invalid' }
	const [actorId, expiry, given] = parts as [string, string, string]
	if (!UUID_RE.test(actorId) || !/^\d{1,16}$/.test(expiry)) return { ok: false, reason: 'invalid' }
	const expiresAt = Number(expiry)
	const expected = Buffer.from(sign(key, actorId, expiresAt))
	const actual = Buffer.from(given)
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		return { ok: false, reason: 'invalid' }
	}
	if (expiresAt <= now) return { ok: false, reason: 'expired' }
	return { ok: true, actorId }
}
