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

// A link can be scoped to one kind of email (today: flow_activity). It then carries the kind as a
// fourth part and the kind is part of what is signed, so it cannot be swapped for the summary
// stop or the other way round. A link without a kind stops the summary, as before.
const KIND_RE = /^[a-z_]{1,32}$/

function sign(key: string, actorId: string, expiresAt: number, kind?: string): string {
	const purpose = kind ? `${EMAIL_STOP_PURPOSE}:${kind}` : EMAIL_STOP_PURPOSE
	return createHmac('sha256', key).update(`${purpose}:${actorId}:${expiresAt}`).digest('base64url')
}

/**
 * `<account id>.<expiry in ms>.<signature>`, or `<account id>.<expiry in ms>.<kind>.<signature>` for
 * a link that stops one kind of email. Throws when the secret is not set.
 */
export function signEmailStopToken(actorId: string, now = Date.now(), kind?: string): string {
	const key = secret()
	if (!key) throw new Error('EMAIL_STOP_LINK_SECRET is not set')
	if (kind !== undefined && !KIND_RE.test(kind)) throw new Error('Invalid email kind')
	const id = actorId.toLowerCase()
	const expiresAt = now + EMAIL_STOP_TTL_MS
	const signature = sign(key, id, expiresAt, kind)
	return kind ? `${id}.${expiresAt}.${kind}.${signature}` : `${id}.${expiresAt}.${signature}`
}

export type EmailStopVerdict =
	| { ok: true; actorId: string; kind: string | null }
	| { ok: false; reason: 'unconfigured' | 'invalid' | 'expired' }

export function verifyEmailStopToken(token: string, now = Date.now()): EmailStopVerdict {
	const key = secret()
	if (!key) return { ok: false, reason: 'unconfigured' }
	const parts = token.split('.')
	if (parts.length !== 3 && parts.length !== 4) return { ok: false, reason: 'invalid' }
	const actorId = parts[0] as string
	const expiry = parts[1] as string
	const kind = parts.length === 4 ? (parts[2] as string) : null
	const given = parts[parts.length - 1] as string
	if (!UUID_RE.test(actorId) || !/^\d{1,16}$/.test(expiry)) return { ok: false, reason: 'invalid' }
	if (kind !== null && !KIND_RE.test(kind)) return { ok: false, reason: 'invalid' }
	const expiresAt = Number(expiry)
	const expected = Buffer.from(sign(key, actorId, expiresAt, kind ?? undefined))
	const actual = Buffer.from(given)
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		return { ok: false, reason: 'invalid' }
	}
	if (expiresAt <= now) return { ok: false, reason: 'expired' }
	return { ok: true, actorId, kind }
}
