import { logger } from '../../../logger'
import { IntegrationAuthRevokedError } from '../../errors'
import type { CustomAuthContext, CustomAuthHandler, StoredCredentials } from '../../types'

/**
 * Dinero personal integration sign-in. The client id and secret go in a Basic header and
 * the API key is both username and password (grant type password). The answer is a bearer
 * token for the one company the key was made for, good for an hour, with no refresh token:
 * when it ends, ask again with the same three values. No browser, no person.
 */
export const DINERO_TOKEN_URL = 'https://authz.dinero.dk/dineroapi/oauth/token'
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000

/** What Dinero said to a sign-in, reduced to what callers branch on. */
export type DineroAuthFailure = 'rejected' | 'transient'

/**
 * Dinero answered, but said no (wrong id, secret or key, or the credentials were not
 * approved yet), or could not be reached. Carries a status and nothing else: the three
 * values must never reach a log, an event or an error message.
 */
export class DineroAuthError extends Error {
	constructor(
		readonly kind: DineroAuthFailure,
		readonly status: number | null,
		message: string,
	) {
		super(message)
		this.name = 'DineroAuthError'
	}
}

export interface DineroKeys {
	clientId: string
	clientSecret: string
	apiKey: string
}

interface TokenResponse {
	access_token?: string
	token_type?: string
	expires_in?: number
}

/** Asks Dinero for a token with the three values. Used at connect and every hour after. */
export async function requestToken(keys: DineroKeys): Promise<{
	accessToken: string
	expiresAt: number
	tokenType: string
}> {
	const basic = Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString('base64')
	let res: Response
	try {
		res = await fetch(DINERO_TOKEN_URL, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${basic}`,
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body: new URLSearchParams({
				grant_type: 'password',
				scope: 'read write',
				username: keys.apiKey,
				password: keys.apiKey,
			}).toString(),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch {
		// Not the underlying error: undici puts the request on it, and a stack trace
		// should not be able to carry a header.
		throw new DineroAuthError('transient', null, 'Dinero could not be reached')
	}
	if (res.status === 400 || res.status === 401 || res.status === 403) {
		throw new DineroAuthError('rejected', res.status, `Dinero refused the sign-in (${res.status})`)
	}
	if (!res.ok) {
		throw new DineroAuthError('transient', res.status, `Dinero sign-in failed (${res.status})`)
	}
	let raw: TokenResponse
	try {
		raw = (await res.json()) as TokenResponse
	} catch {
		throw new DineroAuthError('transient', res.status, 'Dinero sign-in returned a bad body')
	}
	if (!raw.access_token) {
		throw new DineroAuthError('transient', res.status, 'Dinero sign-in returned no token')
	}
	return {
		accessToken: raw.access_token,
		// Dinero says expires_in: 3600. Without one, treat the token as already due rather
		// than as non-expiring, so a missing field costs a renewal, not an outage.
		expiresAt: Date.now() + (raw.expires_in ?? 0) * 1000,
		tokenType: raw.token_type ?? 'Bearer',
	}
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

/** The three values out of a stored blob, or null when one is missing. */
export function keysFrom(credentials: StoredCredentials): DineroKeys | null {
	const { clientId, clientSecret, apiKey } = credentials as Record<string, unknown>
	if (
		typeof clientId === 'string' &&
		clientId &&
		typeof clientSecret === 'string' &&
		clientSecret &&
		typeof apiKey === 'string' &&
		apiKey
	) {
		return { clientId, clientSecret, apiKey }
	}
	return null
}

export const dineroAuth: CustomAuthHandler = {
	// Dinero connects from a form, never from a redirect. These exist because the
	// interface asks for them; the generic OAuth routes must not reach them.
	getInstallUrl(): never {
		throw new Error('Dinero connects with a client id, secret and API key, not a redirect')
	},
	async handleCallback(): Promise<StoredCredentials> {
		throw new Error('Dinero connects with a client id, secret and API key, not a redirect')
	},

	async getAccessToken(credentials: StoredCredentials, ctx: CustomAuthContext): Promise<string> {
		if (stillValid(credentials)) return credentials.accessToken

		const { integrationId } = ctx
		// Nothing is burned by asking twice, but a burst of calls should not each ask.
		// Under the lock, read what is stored now: another server may just have renewed.
		return ctx.withRefreshLock(async (current) => {
			if (stillValid(current)) return current.accessToken

			const keys = keysFrom(current)
			if (!keys) {
				throw new IntegrationAuthRevokedError(
					integrationId,
					'No stored Dinero keys. Please reconnect the integration',
				)
			}
			try {
				const token = await requestToken(keys)
				await ctx.persistCredentials({ ...current, ...token })
				return token.accessToken
			} catch (err) {
				if (err instanceof DineroAuthError && err.kind === 'rejected') {
					logger.warn('Dinero sign-in was refused', { integrationId, status: err.status })
					throw new IntegrationAuthRevokedError(
						integrationId,
						'Dinero refused the stored keys. Please reconnect the integration',
					)
				}
				throw err
			}
		})
	},
}
