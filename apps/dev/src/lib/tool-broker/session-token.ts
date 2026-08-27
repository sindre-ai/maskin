import { createHmac, timingSafeEqual } from 'node:crypto'

// A short-lived token binding an agent container to one workspace + actor.
//
// WHY NOT REUSE THE SESSION'S MASKIN API KEY. The container already carries
// MASKIN_API_KEY, and the proxy could have sat behind the normal auth
// middleware. But that key is the agent's full API credential; handing it to a
// second surface widens what a leaked container env grants. This token is
// scoped to one thing — reach this workspace's toolkit, until it expires — so a
// leak costs the toolkit, not the API.
//
// Stateless on purpose: no table, no lookup on the hot path. The signature
// carries everything the proxy needs, and expiry bounds the damage instead of a
// revocation list.

const DEFAULT_TTL_SECONDS = 12 * 60 * 60

export interface ToolBrokerSessionClaims {
	readonly sessionId: string
	readonly workspaceId: string
	readonly actorId: string
	/** Unix seconds. */
	readonly exp: number
}

const secret = (): string => {
	const value = process.env.TOOL_BROKER_SESSION_SECRET
	if (!value || value.length < 32) {
		throw new Error(
			'TOOL_BROKER_SESSION_SECRET must be set to at least 32 characters to mint tool-broker session tokens',
		)
	}
	return value
}

const payloadOf = (claims: ToolBrokerSessionClaims): string =>
	[claims.sessionId, claims.workspaceId, claims.actorId, String(claims.exp)].join('|')

const sign = (payload: string): string =>
	createHmac('sha256', secret()).update(payload).digest('base64url')

export const mintToolBrokerSessionToken = (
	input: { sessionId: string; workspaceId: string; actorId: string },
	ttlSeconds = DEFAULT_TTL_SECONDS,
): string => {
	const claims: ToolBrokerSessionClaims = {
		...input,
		exp: Math.floor(Date.now() / 1000) + ttlSeconds,
	}
	const payload = payloadOf(claims)
	return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`
}

/**
 * Verify a token and return its claims, or null.
 *
 * Returns null for every failure rather than throwing or distinguishing them:
 * the caller answers 401 either way, and a caller that cannot tell "bad
 * signature" from "expired" cannot be used to probe for either.
 */
export const verifyToolBrokerSessionToken = (token: string): ToolBrokerSessionClaims | null => {
	const [encoded, signature] = token.split('.')
	if (!encoded || !signature) return null

	let payload: string
	try {
		payload = Buffer.from(encoded, 'base64url').toString()
	} catch {
		return null
	}

	const expected = sign(payload)
	// Constant-time, and length-checked first because timingSafeEqual throws on
	// a length mismatch rather than returning false.
	const a = Buffer.from(signature)
	const b = Buffer.from(expected)
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null

	const [sessionId, workspaceId, actorId, exp] = payload.split('|')
	if (!sessionId || !workspaceId || !actorId || !exp) return null

	const expiry = Number(exp)
	if (!Number.isFinite(expiry) || expiry <= Math.floor(Date.now() / 1000)) return null

	return { sessionId, workspaceId, actorId, exp: expiry }
}
