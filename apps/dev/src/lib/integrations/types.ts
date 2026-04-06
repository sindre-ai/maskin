// ── Auth configs ────────────────────────────────────────────────────────────

export interface OAuth2Config {
	authorizationUrl: string
	tokenUrl: string
	/** Defaults to tokenUrl if not set */
	refreshUrl?: string
	revokeUrl?: string
	scopes: string[]
	/** Enable PKCE (S256 code challenge). Default: false */
	pkce?: boolean
	/** How to send client credentials on token exchange. Default: 'client_secret_post' */
	tokenAuthMethod?: 'client_secret_post' | 'client_secret_basic'
	/** Extra params appended to the authorization URL (e.g. Reddit: { duration: 'permanent' }) */
	extraAuthParams?: Record<string, string>
	/** Extra params added to token exchange request body */
	extraTokenParams?: Record<string, string>
	/** Env var name for OAuth client ID */
	clientIdEnv: string
	/** Env var name for OAuth client secret */
	clientSecretEnv: string
}

export interface ApiKeyConfig {
	headerName: string
	headerPrefix?: string
	envKeyName: string
	/** Additional credential fields to inject as env vars: { credentialField → envVarName } */
	extraCredentialEnvKeys?: Record<string, string>
}

export type AuthConfig =
	| { type: 'oauth2'; config: OAuth2Config }
	| { type: 'oauth2_custom' }
	| { type: 'api_key'; config: ApiKeyConfig }

// ── Webhook config ─────────────────────────────────────────────────────────

export interface WebhookConfig {
	/** Header containing the signature (e.g. 'x-hub-signature-256') */
	signatureHeader: string
	signatureScheme: 'hmac-sha256' | 'hmac-sha1' | 'timestamp'
	/** Prefix before the hex digest (e.g. 'sha256=' for GitHub) */
	signaturePrefix?: string
	/** Env var name for the webhook signing secret */
	secretEnv: string
	/** Header containing the event type (e.g. 'x-github-event') */
	eventTypeHeader?: string
	/** Header containing the timestamp (required for 'timestamp' scheme, e.g. 'x-slack-request-timestamp') */
	timestampHeader?: string
	/** Header containing the timestamp-based signature (required for 'timestamp' scheme, e.g. 'x-slack-signature') */
	timestampSignatureHeader?: string
	/**
	 * Template for the signing base string. Use `{timestamp}` and `{body}` placeholders.
	 * Required for 'timestamp' scheme. Example: 'v0:{timestamp}:{body}'
	 */
	timestampBodyTemplate?: string
	/**
	 * Prefix prepended to the computed HMAC hex digest for comparison.
	 * Used with 'timestamp' scheme. Example: 'v0='
	 */
	timestampSignaturePrefix?: string
}

// ── MCP config ─────────────────────────────────────────────────────────────

export interface McpConfig {
	command: string
	args: string[]
	/** Env var the MCP server reads for its auth token */
	envKey: string
}

// ── Events ─────────────────────────────────────────────────────────────────

export interface EventDefinition {
	entityType: string
	actions: string[]
	label: string
}

export interface NormalizedEvent {
	entityType: string
	action: string
	installationId: string
	data: Record<string, unknown>
}

/** Declarative event mapping: provider event key → normalized event */
export interface EventMapping {
	[providerEventKey: string]: {
		entityType: string
		action: string
	}
}

// ── Provider config ────────────────────────────────────────────────────────

export interface ProviderConfig {
	name: string
	displayName: string
	description?: string
	logoUrl?: string
	auth: AuthConfig
	webhook?: WebhookConfig | { type: 'custom' }
	events?: {
		definitions: EventDefinition[]
		mapping?: EventMapping
	}
	mcp?: McpConfig
}

// ── Custom handler interfaces ──────────────────────────────────────────────

export interface StoredCredentials {
	accessToken?: string
	refreshToken?: string
	/** Unix timestamp in milliseconds */
	expiresAt?: number
	scope?: string
	tokenType?: string
	[key: string]: unknown
}

export interface CustomAuthHandler {
	getInstallUrl(state: string): string
	handleCallback(params: Record<string, string>): Promise<StoredCredentials>
	getAccessToken(credentials: StoredCredentials): Promise<string>
}

export type CustomEventNormalizer = (
	payload: unknown,
	headers: Record<string, string>,
) => NormalizedEvent | null

// ── Resolved provider (returned by registry) ──────────────────────────────

export interface ResolvedProvider {
	config: ProviderConfig
	customAuth?: CustomAuthHandler
	customNormalizer?: CustomEventNormalizer
	/** Override token response parsing for providers with non-standard format */
	parseTokenResponse?: (raw: unknown) => Partial<StoredCredentials>
	/** Custom webhook signature verification. Required when webhook type is 'custom'. */
	customWebhookVerifier?: (body: string, headers: Record<string, string>) => boolean
	/**
	 * Resolve a stable external ID after OAuth2 token exchange.
	 * Must return the same ID that extractInstallationId() will find in webhook payloads.
	 * Only needed for providers that receive webhooks via standard OAuth2 (not oauth2_custom).
	 */
	resolveExternalId?: (credentials: StoredCredentials) => Promise<string>
	/**
	 * Pre-handler for webhook payloads. Runs after signature verification but before normalization.
	 * Return a Response to short-circuit normal processing (e.g. Slack url_verification challenge).
	 */
	webhookPreHandler?: (
		payload: unknown,
		headers: Record<string, string>,
	) => { body: unknown; status?: number } | null
}
