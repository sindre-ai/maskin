import { type JWTPayload, SignJWT, jwtVerify } from 'jose'

// Session tokens are short-lived JWTs, HMAC-signed (HS256) with
// VAERKSTED_AUTH_SESSION_JWT_SECRET — distinct from the Ed25519 device-cert
// signing key (design doc §6 step 3's "the password/session token is not
// retained" — this token authenticates only the brief window between login
// and device-cert issuance, or a re-login). Uses `jose` (pure ESM, no native
// bindings) for the same esbuild-bundling reason `@maskin/vaerksted-crypto`
// picked `@noble/curves` — see that package's doc comment and
// `.claude/rules/known-pitfalls.md`.

const SESSION_TOKEN_TTL_SECONDS = 15 * 60 // 15 minutes — long enough to complete
// login → device registration, short enough that a leaked token is a narrow
// window. Not the same TTL as a device cert (24h, design doc §6) — sessions
// and certs are different-lifetime credentials by design.

export type SessionTokenPayload = JWTPayload & {
	identityId: string
}

export async function issueSessionToken(identityId: string, secret: string): Promise<string> {
	const key = new TextEncoder().encode(secret)
	return new SignJWT({ identityId })
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime(`${SESSION_TOKEN_TTL_SECONDS}s`)
		.sign(key)
}

export class InvalidSessionTokenError extends Error {
	constructor(cause?: unknown) {
		super('Invalid or expired session token')
		this.name = 'InvalidSessionTokenError'
		this.cause = cause
	}
}

export async function verifySessionToken(
	token: string,
	secret: string,
): Promise<SessionTokenPayload> {
	const key = new TextEncoder().encode(secret)
	try {
		const { payload } = await jwtVerify(token, key)
		if (typeof payload.identityId !== 'string' || payload.identityId.length === 0) {
			throw new Error('missing identityId claim')
		}
		return payload as SessionTokenPayload
	} catch (err) {
		throw new InvalidSessionTokenError(err)
	}
}
