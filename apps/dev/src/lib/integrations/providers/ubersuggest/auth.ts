import { createS256CodeChallenge, generateCodeVerifier } from '../../oauth/pkce'
import type { CustomAuthHandler, StoredCredentials } from '../../types'

const BASE_URL = 'https://ubersuggest-mcp.neilpatelapi.com'
const SCOPES = 'profile domain keywords serp backlinks site_audit content projects utility'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

// Temporary in-memory store: state -> { clientId, codeVerifier, redirectUri }
// Cleared after callback. Short-lived (OAuth flow completes in seconds).
const pendingAuths = new Map<
	string,
	{ clientId: string; codeVerifier: string; redirectUri: string }
>()

function buildRedirectUri(): string {
	const corsOrigin = process.env.CORS_ORIGIN
	if (corsOrigin) {
		const origin = (corsOrigin.split(',')[0] ?? corsOrigin).trim().replace(/\/$/, '')
		return `${origin}/api/integrations/ubersuggest/callback`
	}
	return 'http://localhost:3000/api/integrations/ubersuggest/callback'
}

export const ubersuggestAuth: CustomAuthHandler = {
	async getInstallUrl(state: string): Promise<string> {
		const redirectUri = buildRedirectUri()

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
		pendingAuths.set(state, { clientId: reg.client_id, codeVerifier, redirectUri })

		const url = new URL(`${BASE_URL}/authorize`)
		url.searchParams.set('response_type', 'code')
		url.searchParams.set('client_id', reg.client_id)
		url.searchParams.set('redirect_uri', redirectUri)
		url.searchParams.set('scope', SCOPES)
		url.searchParams.set('state', state)
		url.searchParams.set('code_challenge', createS256CodeChallenge(codeVerifier))
		url.searchParams.set('code_challenge_method', 'S256')

		return url.toString()
	},

	async handleCallback(params: Record<string, string>): Promise<StoredCredentials> {
		const { code, state } = params
		if (!code) throw new Error('Missing code parameter in Ubersuggest callback')
		if (!state) throw new Error('Missing state parameter in Ubersuggest callback')

		const pending = pendingAuths.get(state)
		if (!pending) throw new Error('Unknown OAuth state — flow may have expired, please reconnect')
		pendingAuths.delete(state)

		const { clientId, codeVerifier, redirectUri } = pending

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

	async getAccessToken(credentials: StoredCredentials): Promise<string> {
		// Return current token if still valid
		if (
			credentials.accessToken &&
			credentials.expiresAt &&
			(credentials.expiresAt as number) > Date.now() + REFRESH_BUFFER_MS
		) {
			return credentials.accessToken as string
		}

		// Try refresh
		if (credentials.refreshToken && credentials.clientId) {
			const tokenRes = await fetch(`${BASE_URL}/token`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: credentials.refreshToken as string,
					client_id: credentials.clientId as string,
				}).toString(),
			})
			if (tokenRes.ok) {
				const raw = (await tokenRes.json()) as { access_token: string }
				return raw.access_token
			}
		}

		if (!credentials.accessToken) {
			throw new Error('No valid Ubersuggest token — please reconnect the integration')
		}
		return credentials.accessToken as string
	},
}
