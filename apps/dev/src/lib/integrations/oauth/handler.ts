import { fillCustomerValue, hasCustomerValueToken } from '../customer-value'
import { getEnvOrThrow } from '../env'
import { assertPublicHost } from '../public-host'
import type { OAuth2Config, StoredCredentials } from '../types'
import { createS256CodeChallenge } from './pkce'

/**
 * Thrown when the OAuth2 provider rejects a token request.
 *
 * Carries the HTTP status, the raw response body, and the parsed OAuth2 `error`
 * field (e.g. `invalid_grant`) so callers can distinguish recoverable failures
 * from terminal ones (grant revoked, user disconnected app) without re-parsing
 * the message string.
 */
export class TokenRequestError extends Error {
	readonly status: number
	readonly oauthError?: string
	readonly responseBody: string

	constructor(
		status: number,
		responseBody: string,
		oauthError?: string,
		operation = 'Token exchange',
	) {
		super(`${operation} failed: ${status} ${responseBody}`)
		this.name = 'TokenRequestError'
		this.status = status
		this.responseBody = responseBody
		this.oauthError = oauthError
	}
}

function parseOAuthErrorField(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body)
		if (parsed && typeof parsed === 'object' && 'error' in parsed) {
			const value = (parsed as { error: unknown }).error
			if (typeof value === 'string') return value
		}
	} catch {
		// Body wasn't JSON — provider didn't follow RFC 6749; no error field to surface.
	}
	return undefined
}

/** A workspace's own sign-in app. When one is passed it wins over the server settings. */
export interface OAuthClientApp {
	clientId: string
	/** Empty for a public client (tokenAuthMethod 'none'), which has no secret. */
	clientSecret: string
	/** The customer's own address or tenant (OAuth2Config.customerValue), put into the URLs. */
	value?: string
}

export class OAuth2Handler {
	private customParser?: (raw: unknown) => Partial<StoredCredentials>

	constructor(
		private config: OAuth2Config,
		customParser?: (raw: unknown) => Partial<StoredCredentials>,
		private app?: OAuthClientApp,
	) {
		this.customParser = customParser
	}

	/** A URL of the tool's setup with the customer's value in it, checked again on the way in. */
	private url(template: string): string {
		return fillCustomerValue(template, this.config.customerValue, this.app?.value)
	}

	/**
	 * Where a request to the customer's own host goes: looked up first and refused unless every
	 * address is public, and sent with redirects off, so neither a name that points inside our
	 * network nor a redirect to another host is ever followed. A tool at a fixed address is unchanged.
	 */
	private async guardedFetch(template: string, init: RequestInit): Promise<Response> {
		const url = this.url(template)
		if (!hasCustomerValueToken(template)) return fetch(url, init)
		await assertPublicHost(new URL(url).hostname)
		return fetch(url, { ...init, redirect: 'manual' })
	}

	private clientId(): string {
		return this.app?.clientId ?? getEnvOrThrow(this.config.clientIdEnv)
	}

	/**
	 * Build the authorization URL the user should be redirected to.
	 * If PKCE is enabled, pass a code verifier to include a code challenge.
	 */
	createAuthorizationUrl(state: string, redirectUri: string, codeVerifier?: string): string {
		const url = new URL(this.url(this.config.authorizationUrl))
		url.searchParams.set('response_type', 'code')
		url.searchParams.set('client_id', this.clientId())
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

		return this.sendTokenRequest(body, this.config.refreshUrl)
	}

	/** Revoke a token if the provider supports it. */
	async revokeToken(token: string): Promise<void> {
		if (!this.config.revokeUrl) return

		const body = new URLSearchParams({ token })
		const headers = this.buildAuthHeaders()
		headers.set('Content-Type', 'application/x-www-form-urlencoded')

		const response = await this.guardedFetch(this.config.revokeUrl, {
			method: 'POST',
			headers,
			body: body.toString(),
		})

		if (!response.ok) {
			const text = await response.text()
			throw new TokenRequestError(
				response.status,
				text,
				parseOAuthErrorField(text),
				'Token revocation',
			)
		}
	}

	private async sendTokenRequest(
		body: URLSearchParams,
		urlOverride?: string,
	): Promise<StoredCredentials> {
		const headers = this.buildAuthHeaders()
		headers.set('Content-Type', 'application/x-www-form-urlencoded')
		headers.set('Accept', 'application/json')

		// Add client credentials to body if using client_secret_post; a public client ('none')
		// sends its id only, and PKCE proves the exchange.
		const method = this.config.tokenAuthMethod ?? 'client_secret_post'
		if (method === 'client_secret_post') {
			body.set('client_id', this.clientId())
			body.set('client_secret', this.clientSecret())
		} else if (method === 'none') {
			body.set('client_id', this.clientId())
		}

		const response = await this.guardedFetch(urlOverride ?? this.config.tokenUrl, {
			method: 'POST',
			headers,
			body: body.toString(),
		})

		if (!response.ok) {
			const text = await response.text()
			throw new TokenRequestError(response.status, text, parseOAuthErrorField(text))
		}

		const raw = await response.json()
		const parsed = this.parseTokenResponse(raw as Record<string, unknown>)

		// Apply custom parser to the raw response and merge with standard parsing
		if (this.customParser) {
			return { ...parsed, ...this.customParser(raw) }
		}

		return parsed
	}

	private clientSecret(): string {
		if (this.app) return this.app.clientSecret
		if (!this.config.clientSecretEnv) {
			throw new Error(
				'OAuth config has no clientSecretEnv, but its token auth method needs a secret',
			)
		}
		return getEnvOrThrow(this.config.clientSecretEnv)
	}

	private buildAuthHeaders(): Headers {
		const headers = new Headers()
		const method = this.config.tokenAuthMethod ?? 'client_secret_post'

		if (method === 'client_secret_basic') {
			const clientId = this.clientId()
			const clientSecret = this.clientSecret()
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
