import { decrypt, encrypt } from '../../../crypto'
import { logger } from '../../../logger'
import { IntegrationAuthRevokedError } from '../../errors'
import { createS256CodeChallenge, generateCodeVerifier } from '../../oauth/pkce'
import type { CustomAuthContext, CustomAuthHandler, StoredCredentials } from '../../types'

const BASE_URL = 'https://ubersuggest-mcp.neilpatelapi.com'
const SCOPES = 'profile domain keywords serp backlinks site_audit content projects utility'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

/**
 * Per-flow material this handler must carry from `getInstallUrl` to
 * `handleCallback`: the dynamically-registered `client_id` (RFC 7591) and the
 * PKCE verifier.
 *
 * These ride inside the encrypted `state` param rather than a process-local
 * map. The callback can be served by a different process than the one that
 * built the authorize URL — a deploy, a crash, or a second replica between the
 * user clicking Connect and approving consent — and a map would strand the
 * flow with an unrecoverable "unknown state" error. It would also grow without
 * bound, since abandoned flows never reach the callback that deletes them.
 *
 * This mirrors how the generic OAuth2 path stores its `codeVerifier` (see
 * `statePayload.codeVerifier` in routes/integrations.ts). Re-encrypting is
 * safe: the callback route decrypts the same envelope, and every field it
 * validates (`nonce`, `workspaceId`, `actorId`, `ts`) is preserved verbatim.
 */
interface UbersuggestFlowState {
	ubersuggest: { clientId: string; codeVerifier: string; redirectUri: string }
}

/** Re-encrypt the framework's state envelope with this flow's PKCE material added. */
function embedFlowState(state: string, flow: UbersuggestFlowState['ubersuggest']): string {
	const payload = JSON.parse(decrypt(state)) as Record<string, unknown>
	return encrypt(JSON.stringify({ ...payload, ubersuggest: flow }))
}

/** Recover the material `getInstallUrl` embedded, or explain what to do instead. */
function readFlowState(state: string): UbersuggestFlowState['ubersuggest'] {
	let payload: Partial<UbersuggestFlowState>
	try {
		payload = JSON.parse(decrypt(state)) as Partial<UbersuggestFlowState>
	} catch {
		throw new Error('Invalid Ubersuggest OAuth state — please reconnect the integration')
	}
	const flow = payload.ubersuggest
	if (!flow?.clientId || !flow.codeVerifier || !flow.redirectUri) {
		throw new Error('Ubersuggest OAuth state is missing PKCE material — please reconnect')
	}
	return flow
}

export const ubersuggestAuth: CustomAuthHandler = {
	/**
	 * `redirectUri` is supplied by the connect route (`resolvePublicOrigin`), not
	 * re-derived here: it has to be byte-identical to what the callback side of
	 * the flow presents, and it is the only place that knows the forwarded host
	 * when `CORS_ORIGIN` is unset. It is registered with the client below *and*
	 * echoed back at token exchange, so it also rides in the flow state.
	 */
	async getInstallUrl(state: string, redirectUri: string): Promise<string> {
		// Dynamic client registration (RFC 7591) — no pre-configured credentials needed
		const regRes = await fetch(`${BASE_URL}/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
			}),
		})
		if (!regRes.ok) {
			const text = await regRes.text()
			throw new Error(`Ubersuggest client registration failed: ${regRes.status} ${text}`)
		}
		const reg = (await regRes.json()) as { client_id: string }

		const codeVerifier = generateCodeVerifier()
		const flowState = embedFlowState(state, {
			clientId: reg.client_id,
			codeVerifier,
			redirectUri,
		})

		const url = new URL(`${BASE_URL}/authorize`)
		url.searchParams.set('response_type', 'code')
		url.searchParams.set('client_id', reg.client_id)
		url.searchParams.set('redirect_uri', redirectUri)
		url.searchParams.set('scope', SCOPES)
		url.searchParams.set('state', flowState)
		url.searchParams.set('code_challenge', createS256CodeChallenge(codeVerifier))
		url.searchParams.set('code_challenge_method', 'S256')

		return url.toString()
	},

	async handleCallback(params: Record<string, string>): Promise<StoredCredentials> {
		const { code, state } = params
		if (!code) throw new Error('Missing code parameter in Ubersuggest callback')
		if (!state) throw new Error('Missing state parameter in Ubersuggest callback')

		const { clientId, codeVerifier, redirectUri } = readFlowState(state)

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
