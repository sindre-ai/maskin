import { logger } from '../../../logger'
import { IntegrationAuthRevokedError } from '../../errors'
import type { CustomAuthContext, CustomAuthHandler, StoredCredentials } from '../../types'

export const DEEPDOTS_BASE_URL = 'https://api.deepdots.com'
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

interface TokenResponse {
	idToken?: string
	refreshToken?: string
	expiresIn?: number
	tokenType?: string
}

/** What Deepdots said to a sign-in or refresh, reduced to what callers branch on. */
export type DeepdotsAuthFailure = 'rejected' | 'transient'

/**
 * Deepdots answered, but said no. 401 (wrong email or password) and 403 (user
 * disabled, origin or IP not allowed) are final until a person fixes the login.
 * Carries a status and nothing else: the body can echo the email, and the
 * password must never reach a log, an event or an error message.
 */
export class DeepdotsAuthError extends Error {
	constructor(
		readonly kind: DeepdotsAuthFailure,
		readonly status: number | null,
		message: string,
	) {
		super(message)
		this.name = 'DeepdotsAuthError'
	}
}

async function postJson(path: string, body: Record<string, string>): Promise<Response> {
	try {
		return await fetch(`${DEEPDOTS_BASE_URL}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch {
		// Not the underlying error: undici puts the request on it and a stack trace
		// should not be able to carry a body.
		throw new DeepdotsAuthError('transient', null, 'Deepdots could not be reached')
	}
}

async function readTokens(res: Response, what: string): Promise<TokenResponse> {
	let raw: TokenResponse
	try {
		raw = (await res.json()) as TokenResponse
	} catch {
		throw new DeepdotsAuthError('transient', res.status, `Deepdots ${what} returned a bad body`)
	}
	if (!raw.idToken) {
		throw new DeepdotsAuthError('transient', res.status, `Deepdots ${what} returned no token`)
	}
	return raw
}

function toCredentials(
	base: StoredCredentials,
	raw: TokenResponse,
	fallbackRefresh?: string,
): StoredCredentials {
	return {
		...base,
		accessToken: raw.idToken,
		refreshToken: raw.refreshToken ?? fallbackRefresh,
		// Deepdots says expiresIn: 3600. Without one, treat the token as already due
		// rather than as non-expiring, so a missing field costs a renewal, not an outage.
		expiresAt: Date.now() + (raw.expiresIn ?? 0) * 1000,
		tokenType: raw.tokenType ?? 'Bearer',
	}
}

/**
 * Sign in with the email and password. Used once at connect and again whenever
 * a refresh is refused.
 */
export async function signIn(email: string, password: string): Promise<StoredCredentials> {
	const res = await postJson('/auth/token', { email, password })
	if (res.status === 401 || res.status === 403) {
		throw new DeepdotsAuthError(
			'rejected',
			res.status,
			`Deepdots refused the sign-in (${res.status})`,
		)
	}
	if (!res.ok) {
		throw new DeepdotsAuthError('transient', res.status, `Deepdots sign-in failed (${res.status})`)
	}
	const raw = await readTokens(res, 'sign-in')
	return toCredentials({ email, password }, raw)
}

/**
 * Trade the refresh token for a new token. Deepdots returns a NEW refresh token
 * every time and the old one stops working, so the caller must store the result.
 */
async function refresh(credentials: StoredCredentials): Promise<StoredCredentials> {
	const res = await postJson('/auth/token/refresh', {
		refreshToken: credentials.refreshToken as string,
	})
	if (res.status === 400 || res.status === 401 || res.status === 403) {
		throw new DeepdotsAuthError(
			'rejected',
			res.status,
			`Deepdots refused the refresh (${res.status})`,
		)
	}
	if (!res.ok) {
		throw new DeepdotsAuthError('transient', res.status, `Deepdots refresh failed (${res.status})`)
	}
	const raw = await readTokens(res, 'refresh')
	return toCredentials(credentials, raw, credentials.refreshToken)
}

function stillValid(credentials: StoredCredentials): credentials is StoredCredentials & {
	accessToken: string
} {
	return (
		typeof credentials.accessToken === 'string' &&
		credentials.accessToken.length > 0 &&
		typeof credentials.expiresAt === 'number' &&
		credentials.expiresAt > Date.now() + REFRESH_BUFFER_MS
	)
}

function hasLogin(
	credentials: StoredCredentials,
): credentials is StoredCredentials & { email: string; password: string } {
	return typeof credentials.email === 'string' && typeof credentials.password === 'string'
}

export const deepdotsAuth: CustomAuthHandler = {
	// Deepdots connects from a form, never from a redirect. These exist because the
	// interface asks for them; the generic OAuth routes must not reach them.
	getInstallUrl(): never {
		throw new Error('Deepdots connects with an email and password, not a redirect')
	},
	async handleCallback(): Promise<StoredCredentials> {
		throw new Error('Deepdots connects with an email and password, not a redirect')
	},

	async getAccessToken(credentials: StoredCredentials, ctx: CustomAuthContext): Promise<string> {
		if (stillValid(credentials)) return credentials.accessToken

		const { integrationId } = ctx
		// A used refresh token is burned, and more than one server can get here at
		// once. Under the lock, read what is stored now: another server may just have
		// renewed, and then there is nothing left to do.
		return ctx.withRefreshLock(async (current) => {
			if (stillValid(current)) return current.accessToken

			if (typeof current.refreshToken === 'string' && current.refreshToken.length > 0) {
				try {
					const renewed = await refresh(current)
					await ctx.persistCredentials(renewed)
					return renewed.accessToken as string
				} catch (err) {
					// A refused refresh means sign in again. Anything else (429, 5xx,
					// network) is transient and must not fall through to a second
					// request that would also fail, or mark anything failed.
					if (!(err instanceof DeepdotsAuthError) || err.kind !== 'rejected') throw err
				}
			}

			if (!hasLogin(current)) {
				throw new IntegrationAuthRevokedError(
					integrationId,
					'No stored Deepdots login. Please reconnect the integration',
				)
			}

			try {
				const signedIn = await signIn(current.email, current.password)
				await ctx.persistCredentials(signedIn)
				return signedIn.accessToken as string
			} catch (err) {
				if (err instanceof DeepdotsAuthError && err.kind === 'rejected') {
					logger.warn('Deepdots sign-in was refused', { integrationId, status: err.status })
					throw new IntegrationAuthRevokedError(
						integrationId,
						'Deepdots refused the stored login. Please reconnect the integration',
					)
				}
				throw err
			}
		})
	},
}
