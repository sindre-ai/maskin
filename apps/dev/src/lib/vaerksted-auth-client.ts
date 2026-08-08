/**
 * HTTP client for calling out to vaerksted-auth (apps/vaerksted-auth) — the
 * standalone identity service from vaerksted-auth-and-sync.md §4. Modeled on
 * `lib/integrations/oauth/handler.ts`'s style for calling an external auth
 * service (typed error classes distinguishing "service unreachable" from
 * "service rejected the request", a single `fetch` call, no retries) — NOT a
 * reuse of the OAuth *integration provider* framework itself, since
 * vaerksted-auth isn't a third-party integration provider Maskin connects a
 * workspace to; it's a sibling auth service Maskin's own backend verifies
 * sessions against.
 *
 * M5 task: without this call, Maskin would have no way to safely learn which
 * vaerksted identity a client-supplied `session_token` belongs to — trusting
 * a client-supplied `identity_id` directly would let any caller claim to be
 * any identity. `verifyVaerkstedSession` is the only place that trust
 * boundary is crossed; callers must treat any failure (network error, non-2xx
 * response) as "unauthenticated," never fall back to trusting the caller.
 */

export class VaerkstedAuthUnreachableError extends Error {
	constructor(cause?: unknown) {
		super('Could not reach vaerksted-auth')
		this.name = 'VaerkstedAuthUnreachableError'
		this.cause = cause
	}
}

export class InvalidVaerkstedSessionError extends Error {
	constructor(status: number) {
		super(`vaerksted-auth rejected the session token (status ${status})`)
		this.name = 'InvalidVaerkstedSessionError'
	}
}

export class VaerkstedAuthNotConfiguredError extends Error {
	constructor() {
		super('VAERKSTED_AUTH_BASE_URL is not set')
		this.name = 'VaerkstedAuthNotConfiguredError'
	}
}

export type VerifiedVaerkstedSession = {
	identityId: string
	email: string | null
}

/**
 * Calls vaerksted-auth's `GET /sessions/me` with the given session token and
 * returns the verified `{identity_id, email}` it belongs to. Throws on any
 * failure — never returns a "best guess" identity.
 */
export async function verifyVaerkstedSession(
	baseUrl: string,
	sessionToken: string,
): Promise<VerifiedVaerkstedSession> {
	let response: Response
	try {
		response = await fetch(`${baseUrl.replace(/\/$/, '')}/sessions/me`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${sessionToken}` },
		})
	} catch (err) {
		throw new VaerkstedAuthUnreachableError(err)
	}

	if (!response.ok) {
		throw new InvalidVaerkstedSessionError(response.status)
	}

	let body: unknown
	try {
		body = await response.json()
	} catch (err) {
		throw new VaerkstedAuthUnreachableError(err)
	}

	const identityId = (body as { identity_id?: unknown }).identity_id
	const email = (body as { email?: unknown }).email
	if (typeof identityId !== 'string') {
		throw new InvalidVaerkstedSessionError(response.status)
	}

	return { identityId, email: typeof email === 'string' ? email : null }
}
