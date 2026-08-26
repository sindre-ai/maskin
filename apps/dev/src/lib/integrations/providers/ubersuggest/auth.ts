import { createHmac } from 'node:crypto'
import { logger } from '../../../logger'
import { IntegrationAuthRevokedError } from '../../errors'
import { createS256CodeChallenge } from '../../oauth/pkce'
import { decodeState } from '../../oauth/state'
import type { CustomAuthContext, CustomAuthHandler, StoredCredentials } from '../../types'

const BASE_URL = 'https://ubersuggest-mcp.neilpatelapi.com'
const SCOPES = 'profile domain keywords serp backlinks site_audit content projects utility'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

/**
 * Ubersuggest's authorize endpoint hands the user off to `app.neilpatel.com`,
 * which parks our `state` in a cookie while it bounces through Google and then
 * validates it on the way back. Our state is embedded in that cookie three
 * times over (once in `next`, twice more inside a base64'd `xUbsData` blob), so
 * every character we add costs roughly four in the cookie. Past ~4KB the
 * browser drops the cookie and the provider answers
 * `{"error":"BAD_REQUEST","description":"`state` is missing or invalid"}` —
 * before the user ever reaches the consent screen.
 *
 * So this handler carries *nothing* extra in the state envelope. The two pieces
 * of per-flow material it needs at callback time are recovered instead:
 *
 * - `codeVerifier` is derived deterministically from the flow's one-time
 *   `nonce` (already in the envelope, already replay-checked against the
 *   pending integration row) keyed by `INTEGRATION_ENCRYPTION_KEY`. It is
 *   unique per flow, never transmitted, and needs no server-side storage — so
 *   the callback can be served by a different replica than the one that built
 *   the authorize URL.
 * - `redirectUri` is supplied by the route on both legs, so it is byte-identical
 *   at registration and at token exchange without a round trip.
 * - `clientId` comes from re-running registration at callback time. Ubersuggest
 *   implements RFC 7591 but returns the same fixed `ubersuggest-mcp` client for
 *   a given redirect URI, so this is stable rather than a fresh client per call.
 */
function deriveCodeVerifier(nonce: string): string {
	const key = process.env.INTEGRATION_ENCRYPTION_KEY
	if (!key) {
		throw new Error('INTEGRATION_ENCRYPTION_KEY environment variable is required')
	}
	return createHmac('sha256', Buffer.from(key, 'hex'))
		.update(`ubersuggest-pkce:${nonce}`)
		.digest('base64url')
}

/** Recover the one-time nonce the connect route minted for this flow. */
function readNonce(state: string): string {
	let payload: { nonce?: string }
	try {
		payload = decodeState<{ nonce?: string }>(state)
	} catch {
		throw new Error('Invalid Ubersuggest OAuth state — please reconnect the integration')
	}
	if (!payload.nonce) {
		throw new Error('Ubersuggest OAuth state is missing its nonce — please reconnect')
	}
	return payload.nonce
}

/**
 * Register (or re-resolve) the OAuth client for this redirect URI.
 * RFC 7591 dynamic registration; no pre-configured credentials needed.
 */
async function registerClient(redirectUri: string): Promise<string> {
	const res = await fetch(`${BASE_URL}/register`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		}),
	})
	if (!res.ok) {
		const text = await res.text()
		throw new Error(`Ubersuggest client registration failed: ${res.status} ${text}`)
	}
	const reg = (await res.json()) as { client_id?: string }
	if (!reg.client_id) {
		throw new Error('Ubersuggest client registration returned no client_id')
	}
	return reg.client_id
}

export const ubersuggestAuth: CustomAuthHandler = {
	/**
	 * `redirectUri` is supplied by the connect route (`resolvePublicOrigin`), not
	 * re-derived here: it has to be byte-identical to what the callback side of
	 * the flow presents, and it is the only place that knows the forwarded host
	 * when `CORS_ORIGIN` is unset. It is registered with the client below *and*
	 * echoed back at token exchange.
	 */
	async getInstallUrl(state: string, redirectUri: string): Promise<string> {
		const clientId = await registerClient(redirectUri)
		const codeVerifier = deriveCodeVerifier(readNonce(state))

		const url = new URL(`${BASE_URL}/authorize`)
		url.searchParams.set('response_type', 'code')
		url.searchParams.set('client_id', clientId)
		url.searchParams.set('redirect_uri', redirectUri)
		url.searchParams.set('scope', SCOPES)
		url.searchParams.set('state', state)
		url.searchParams.set('code_challenge', createS256CodeChallenge(codeVerifier))
		url.searchParams.set('code_challenge_method', 'S256')

		return url.toString()
	},

	async handleCallback(
		params: Record<string, string>,
		redirectUri: string,
	): Promise<StoredCredentials> {
		const { code, state } = params
		if (!code) throw new Error('Missing code parameter in Ubersuggest callback')
		if (!state) throw new Error('Missing state parameter in Ubersuggest callback')

		const codeVerifier = deriveCodeVerifier(readNonce(state))
		const clientId = await registerClient(redirectUri)

		const tokenRes = await fetch(`${BASE_URL}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				redirect_uri: redirectUri,
				client_id: clientId,
				code_verifier: codeVerifier,
			}).toString(),
		})
		if (!tokenRes.ok) {
			const text = await tokenRes.text()
			throw new Error(`Ubersuggest token exchange failed: ${tokenRes.status} ${text}`)
		}

		const raw = (await tokenRes.json()) as {
			access_token: string
			refresh_token?: string
			expires_in?: number
			token_type?: string
		}

		const creds: StoredCredentials = {
			accessToken: raw.access_token,
			clientId, // stored for token refresh
		}
		if (raw.refresh_token) creds.refreshToken = raw.refresh_token
		if (raw.expires_in) creds.expiresAt = Date.now() + raw.expires_in * 1000
		if (raw.token_type) creds.tokenType = raw.token_type

		return creds
	},

	async getAccessToken(credentials: StoredCredentials, ctx?: CustomAuthContext): Promise<string> {
		const integrationId = ctx?.integrationId ?? 'ubersuggest'

		if (!credentials.accessToken) {
			throw new IntegrationAuthRevokedError(
				integrationId,
				'No stored Ubersuggest access token — please reconnect the integration',
			)
		}

		// Still valid, or non-expiring (provider omitted expires_in at install) —
		// use as-is. Mirrors TokenManager's standard OAuth2 path.
		const expiresAt = credentials.expiresAt as number | undefined
		if (!expiresAt || expiresAt > Date.now() + REFRESH_BUFFER_MS) {
			return credentials.accessToken as string
		}

		const refreshToken = credentials.refreshToken as string | undefined
		const clientId = credentials.clientId as string | undefined
		if (!refreshToken || !clientId) {
			// Nothing left to try. Returning the expired token here would inject a
			// dead credential into agent containers and surface as opaque 401s.
			throw new IntegrationAuthRevokedError(
				integrationId,
				'Ubersuggest access token expired and cannot be refreshed — please reconnect the integration',
			)
		}

		const tokenRes = await fetch(`${BASE_URL}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: clientId,
			}).toString(),
		})

		if (!tokenRes.ok) {
			const body = await tokenRes.text()
			logger.warn('Ubersuggest token refresh failed', {
				integrationId,
				status: tokenRes.status,
				error: body.slice(0, 500),
			})
			// 400 invalid_grant / 401 invalid_client are terminal: the grant is gone or
			// the dynamically-registered client no longer exists. Anything else (429,
			// 5xx) is transient — throw a plain Error so the row is not marked revoked.
			if (tokenRes.status === 400 || tokenRes.status === 401) {
				throw new IntegrationAuthRevokedError(
					integrationId,
					'Ubersuggest refresh was rejected — please reconnect the integration',
				)
			}
			throw new Error(`Ubersuggest token refresh failed: ${tokenRes.status}`)
		}

		const raw = (await tokenRes.json()) as {
			access_token?: string
			refresh_token?: string
			expires_in?: number
			token_type?: string
		}
		if (!raw.access_token) {
			throw new Error('Ubersuggest refresh response omitted access_token — please reconnect')
		}

		// Persist the rotated credentials. Ubersuggest registers this as a public
		// PKCE client (token_endpoint_auth_method: 'none'), for which refresh-token
		// rotation is the norm — dropping the new refresh_token would make the *next*
		// refresh replay a consumed token and permanently strand the integration.
		// Storing the new expiry also stops every later call from re-refreshing.
		const updated: StoredCredentials = {
			...credentials,
			accessToken: raw.access_token,
			// Deliberately not falling back to the old expiresAt: it is already in the
			// past, which would re-trigger a refresh on every subsequent call.
			expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : undefined,
		}
		if (raw.refresh_token) updated.refreshToken = raw.refresh_token
		if (raw.token_type) updated.tokenType = raw.token_type

		await ctx?.persistCredentials(updated)

		return raw.access_token
	},
}
