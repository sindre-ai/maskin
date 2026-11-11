import { createHmac, timingSafeEqual } from 'node:crypto'
import { EMAIL_STOP_TTL_MS, secret } from './email-stop-token'

// Signed token for the "Not useful" link under a Marketplace pick. Like the stop link it has to work
// with nobody signed in, so the token is the only credential: an HMAC over the account id, the flow
// id, the purpose and an expiry, keyed by the same EMAIL_STOP_LINK_SECRET. It can add that one flow
// to that one account's dismissed list and do nothing else.

export const EMAIL_PICK_PURPOSE = 'email_pick_dismiss'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function sign(key: string, actorId: string, loopId: string, expiresAt: number): string {
	return createHmac('sha256', key)
		.update(`${EMAIL_PICK_PURPOSE}:${actorId}:${loopId}:${expiresAt}`)
		.digest('base64url')
}

/** `<account id>.<flow id>.<expiry in ms>.<signature>`. Throws when the secret is not set. */
export function signEmailPickToken(actorId: string, loopId: string, now = Date.now()): string {
	const key = secret()
	if (!key) throw new Error('EMAIL_STOP_LINK_SECRET is not set')
	const actor = actorId.toLowerCase()
	const loop = loopId.toLowerCase()
	const expiresAt = now + EMAIL_STOP_TTL_MS
	return `${actor}.${loop}.${expiresAt}.${sign(key, actor, loop, expiresAt)}`
}

export type EmailPickVerdict =
	| { ok: true; actorId: string; loopId: string }
	| { ok: false; reason: 'unconfigured' | 'invalid' | 'expired' }

export function verifyEmailPickToken(token: string, now = Date.now()): EmailPickVerdict {
	const key = secret()
	if (!key) return { ok: false, reason: 'unconfigured' }
	const parts = token.split('.')
	if (parts.length !== 4) return { ok: false, reason: 'invalid' }
	const [actorId, loopId, expiry, given] = parts as [string, string, string, string]
	if (!UUID_RE.test(actorId) || !UUID_RE.test(loopId) || !/^\d{1,16}$/.test(expiry)) {
		return { ok: false, reason: 'invalid' }
	}
	const expiresAt = Number(expiry)
	const expected = Buffer.from(sign(key, actorId, loopId, expiresAt))
	const actual = Buffer.from(given)
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		return { ok: false, reason: 'invalid' }
	}
	if (expiresAt <= now) return { ok: false, reason: 'expired' }
	return { ok: true, actorId, loopId }
}

/** The "Not useful" link for one pick: the public GET and POST /api/email/pick-dismiss route. */
export function buildEmailPickDismissUrl(
	actorId: string,
	loopId: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const base = env.APP_URL?.trim().replace(/\/+$/, '') || 'http://localhost:5173'
	return `${base}/api/email/pick-dismiss?token=${encodeURIComponent(signEmailPickToken(actorId, loopId))}`
}
