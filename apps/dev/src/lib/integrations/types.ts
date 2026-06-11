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
	envKeyName?: string
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

export interface StdioMcpServer {
	type: 'stdio'
	command: string
	args: string[]
	env?: Record<string, string>
}

export interface HttpMcpServer {
	type: 'http'
	url: string
	headers?: Record<string, string>
}

export type McpServerSpec = StdioMcpServer | HttpMcpServer

export interface McpConfig {
	/** Env var the MCP server reads for its auth token. */
	envKey: string
	/**
	 * Legacy stdio metadata kept for symmetry with first-party MCP presets in
	 * the frontend. Not read at runtime — session-manager only consumes envKey
	 * and (when autoInject is set) `server`.
	 */
	command?: string
	args?: string[]
	/**
	 * When true, session-manager merges `server` into MCP_SERVERS_JSON for any
	 * workspace with an active integration of this provider — no per-agent
	 * MCP config required. Use for providers that act as workspace-level data
	 * pipes (e.g. PostHog feeding the Synthesizer) rather than tools a human
	 * opts into per agent.
	 */
	autoInject?: boolean
	/** MCP server spec injected when autoInject=true. */
	server?: McpServerSpec
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
	customWebhookVerifier?: (
		body: string,
		headers: Record<string, string>,
	) => boolean | Promise<boolean>
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
	/**
	 * Return a stable per-delivery ID extracted from a verified webhook payload
	 * (and/or headers). Used to deduplicate provider retries: the route claims a
	 * row in `webhook_deliveries` keyed on (provider, external_id) before
	 * processing, so a retry with the same ID short-circuits with 200 OK.
	 * Return null to opt out of dedup for this delivery.
	 */
	extractDeliveryId?: (payload: unknown, headers: Record<string, string>) => string | null
	/**
	 * Run provider-specific work immediately after OAuth credentials are stored and the
	 * integration is activated (e.g. Gmail's users.watch call). Failures should be logged
	 * by the provider; the route catches and surfaces them as a redirect with an error param.
	 */
	postInstall?: (ctx: PostInstallContext) => Promise<void>
	/**
	 * Expand a single normalized webhook event into multiple events.
	 * Used when a provider's webhook is a notification pointer (e.g. Gmail Pub/Sub push
	 * → users.history.list returns N changes). Called once after normalization with the
	 * matching active integration; returns the events to insert. If absent, the route
	 * inserts the single normalized event as-is.
	 */
	webhookFanOut?: (ctx: WebhookFanOutContext) => Promise<NormalizedEvent[]>
	/**
	 * Process fan-out and event insert in the background after the delivery is
	 * claimed, so the webhook can ack within tight provider budgets (Slack: 3s)
	 * even when the fan-out does heavy work (file downloads). The delivery claim
	 * still runs synchronously so a provider retry that arrives before background
	 * work finishes is deduplicated as a duplicate, not double-processed.
	 */
	asyncProcessing?: boolean
	/**
	 * Run provider-specific cleanup before the integration is marked as revoked
	 * (e.g. Gmail's users.stop call so Google stops sending pushes immediately
	 * instead of waiting up to 7 days for the watch to expire). Implementations
	 * should be best-effort: errors must be caught internally so disconnect can
	 * always succeed.
	 */
	preDisconnect?: (ctx: PreDisconnectContext) => Promise<void>
}

export interface PostInstallContext {
	/** Drizzle Database instance — typed loosely to avoid circular deps with @maskin/db */
	db: unknown
	integrationId: string
	workspaceId: string
	credentials: StoredCredentials
}

export interface WebhookFanOutContext {
	db: unknown
	/** StorageProvider — typed loosely to avoid pulling @maskin/storage into this package */
	storage: unknown
	integrationId: string
	workspaceId: string
	normalized: NormalizedEvent
}

export interface PreDisconnectContext {
	db: unknown
	integrationId: string
	workspaceId: string
}
