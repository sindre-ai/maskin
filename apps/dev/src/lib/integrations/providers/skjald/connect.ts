import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SKJALD_CONNECT_REDIRECT_URI } from '@maskin/shared'
import { createS256CodeChallenge } from '../../oauth/pkce'

/**
 * The pure parts of "Connect with Maskin" from the Skjald app. The app opens `/connect/skjald`, the person picks a
 * workspace, `POST /api/integrations/skjald/authorize` creates the integration and a one-time grant, and the app
 * trades the code for the webhook URL and signing secret at `POST /api/integrations/skjald/exchange`.
 *
 * The grant lives in the integration's `config.skjald_connect` (jsonb), so there is no table to migrate. The secret
 * is held encrypted there until the code is exchanged, and the code only as a hash.
 */

/** How long a code lives. The app trades it within a second of getting it. */
export const CONNECT_CODE_TTL_MS = 2 * 60 * 1000

export interface SkjaldConnectGrant {
	code_hash: string
	code_challenge: string
	/** ISO timestamp. */
	expires_at: string
	/** `encrypt(secret)`: the signing secret, which only `exchange` ever returns. */
	secret_enc: string
	webhook_url: string
	workspace_name: string
}

/** Only the Skjald app's own redirect is allowed: anything else could carry the code to someone else. */
export function isAllowedSkjaldRedirectUri(uri: string): boolean {
	return uri === SKJALD_CONNECT_REDIRECT_URI
}

export function hashConnectCode(code: string): string {
	return createHash('sha256').update(code).digest('hex')
}

/** A one-time code (256 random bits) and the hash that is stored in its place. */
export function mintConnectCode(): { code: string; codeHash: string } {
	const code = randomBytes(32).toString('base64url')
	return { code, codeHash: hashConnectCode(code) }
}

/** The HMAC key Skjald signs deliveries with. Made here, so nobody has to invent or paste one. */
export function generateSigningSecret(): string {
	return randomBytes(32).toString('hex')
}

/** PKCE S256 check, constant time. */
export function verifyPkce(verifier: string, challenge: string): boolean {
	const expected = Buffer.from(createS256CodeChallenge(verifier))
	const given = Buffer.from(challenge)
	return expected.length === given.length && timingSafeEqual(expected, given)
}

export function isGrantLive(
	grant: Pick<SkjaldConnectGrant, 'expires_at'>,
	now = new Date(),
): boolean {
	const expires = Date.parse(grant.expires_at)
	return Number.isFinite(expires) && expires > now.getTime()
}

export function connectRedirectUrl(code: string, state: string): string {
	return `${SKJALD_CONNECT_REDIRECT_URI}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
}

export function deniedRedirectUrl(state: string): string {
	return `${SKJALD_CONNECT_REDIRECT_URI}?error=access_denied&state=${encodeURIComponent(state)}`
}

/** The grant, if `config` holds a well-formed one. */
export function readGrant(config: unknown): SkjaldConnectGrant | null {
	const grant = (config as { skjald_connect?: Partial<SkjaldConnectGrant> } | null)?.skjald_connect
	if (
		grant &&
		typeof grant.code_hash === 'string' &&
		typeof grant.code_challenge === 'string' &&
		typeof grant.expires_at === 'string' &&
		typeof grant.secret_enc === 'string' &&
		typeof grant.webhook_url === 'string' &&
		typeof grant.workspace_name === 'string'
	) {
		return grant as SkjaldConnectGrant
	}
	return null
}

/**
 * A tiny fixed-window limiter for the one route that takes no API key. In memory and per process: it slows a
 * guesser down, it is not the thing that makes guessing hopeless (the code has 256 bits).
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
	const hits = new Map<string, { count: number; resetAt: number }>()
	return function allow(key: string): boolean {
		const t = now()
		if (hits.size > 5000) {
			for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k)
		}
		const entry = hits.get(key)
		if (!entry || entry.resetAt <= t) {
			hits.set(key, { count: 1, resetAt: t + windowMs })
			return true
		}
		entry.count += 1
		return entry.count <= limit
	}
}
