import { getEnvOrThrow } from '../env'
import type { OAuth2Config, StoredCredentials } from '../types'
import { createS256CodeChallenge } from './pkce'

export class OAuth2Handler {
	private customParser?: (raw: unknown) => Partial<StoredCredentials>

	constructor(
		private config: OAuth2Config,
		customParser?: (raw: unknown) => Partial<StoredCredentials>,
	) {
		this.customParser = customParser
	}

	/**
	 * Build the authorization URL the user should be redirected to.
	 * If PKCE is enabled, pass a code verifier to include a code challenge.
	 */
	createAuthorizationUrl(state: string, redirectUri: string, codeVerifier?: string): string {
		const url = new URL(this.config.authorizationUrl)
		url.searchParams.set('response_type', 'code')
		url.searchParams.set('client_id', getEnvOrThrow(this.config.clientIdEnv))
		url.searchParams.set('redirect_uri', redirectUri)
		url.searchParams.set('state', state)

		if (this.config.scopes.length > 0) {
			url.searchParams.set('scope', this.config.scopes.join(' '))
		}

		if (this.config.pkce && codeVerifier) {
			url.searchParams.set('code_challenge', createS256CodeChallenge(codeVerifier))
			url.searchParams.set('code_challenge_method', 'S256')
		}

		if (this.config.extraAuthParams) {
			for (const [key, value] of Object.entries(this.config.extraAuthParams)) {
				url.searchParams.set(key, value)
			}
		}

		return url.toString()
	}

	/**
	 * Exchange an authorization code for tokens.
	 * Returns a standardized StoredCredentials object.
	 */
	async exchangeCode(
		code: string,
		redirectUri: string,
		codeVerifier?: string,
	): Promise<StoredCredentials> {
		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			...this.config.extraTokenParams,
		})

		if (this.config.pkce && codeVerifier) {
			body.set('code_verifier', codeVerifier)
		}

		return this.sendTokenRequest(body)
	}

	/** Refresh an expired access token using a refresh token. */
	async refreshToken(refreshToken: string): Promise<StoredCredentials> {
		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		})

		return this.sendTokenRequest(body)
	}

	/** Revoke a token if the provider supports it. */
	async revokeToken(token: string): Promise<void> {
		if (!this.config.revokeUrl) return

		const body = new URLSearchParams({ token })
		const headers = this.buildAuthHeaders()
		headers.set('Content-Type', 'application/x-www-form-urlencoded')

		await fetch(this.config.revokeUrl, {
			method: 'POST',
			headers,
			body: body.toString(),
		})
	}

	private async sendTokenRequest(body: URLSearchParams): Promise<StoredCredentials> {
		const headers = this.buildAuthHeaders()
		headers.set('Content-Type', 'application/x-www-form-urlencoded')
		headers.set('Accept', 'application/json')

		// Add client credentials to body if using client_secret_post
		const method = this.config.tokenAuthMethod ?? 'client_secret_post'
		if (method === 'client_secret_post') {
			body.set('client_id', getEnvOrThrow(this.config.clientIdEnv))
			body.set('client_secret', getEnvOrThrow(this.config.clientSecretEnv))
		}

		const tokenUrl = this.config.tokenUrl
		const response = await fetch(tokenUrl, {
			method: 'POST',
			headers,
			body: body.toString(),
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Token exchange failed: ${response.status} ${text}`)
		}

		const raw = await response.json()
		const parsed = this.parseTokenResponse(raw as Record<string, unknown>)

		// Apply custom parser to the raw response and merge with standard parsing
		if (this.customParser) {
			return { ...parsed, ...this.customParser(raw) }
		}

		return parsed
	}

	private buildAuthHeaders(): Headers {
		const headers = new Headers()
		const method = this.config.tokenAuthMethod ?? 'client_secret_post'

		if (method === 'client_secret_basic') {
			const clientId = getEnvOrThrow(this.config.clientIdEnv)
			const clientSecret = getEnvOrThrow(this.config.clientSecretEnv)
			const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
			headers.set('Authorization', `Basic ${encoded}`)
		}

		return headers
	}

	private parseTokenResponse(raw: Record<string, unknown>): StoredCredentials {
		const creds: StoredCredentials = {}

		if (typeof raw.access_token === 'string') {
			creds.accessToken = raw.access_token
		}
		if (typeof raw.refresh_token === 'string') {
			creds.refreshToken = raw.refresh_token
		}
		if (typeof raw.token_type === 'string') {
			creds.tokenType = raw.token_type
		}
		if (typeof raw.scope === 'string') {
			creds.scope = raw.scope
		}

		// Calculate expiry
		if (typeof raw.expires_at === 'number') {
			// If > 1e12, value is already in milliseconds; otherwise convert from seconds
			creds.expiresAt = raw.expires_at > 1e12 ? raw.expires_at : raw.expires_at * 1000
		} else if (typeof raw.expires_in === 'number') {
			creds.expiresAt = Date.now() + raw.expires_in * 1000
		}

		return creds
	}
}
