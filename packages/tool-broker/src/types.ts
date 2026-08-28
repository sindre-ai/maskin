// Public vocabulary for the tool broker client.
//
// Everything here is stated in MASKIN's terms — workspaces, actors, integrations
// — not the backend's. The backend's own concepts (tenants, subjects, toolkits,
// glob patterns over tool addresses) exist only inside `client.ts`, which is the
// single place that translates between the two. Nothing outside this package
// should need to know how the backend models any of this.

/** A tool source available to a workspace (an MCP server or an OpenAPI spec). */
export interface BrokerIntegration {
	/** Backend-side identifier. Carries the workspace prefix; not for display. */
	readonly slug: string
	/** Human-readable name, safe to show in the UI. */
	readonly name: string
	readonly kind: 'mcp' | 'openapi'
	/** Whether this workspace may remove it. */
	readonly removable: boolean
	/** Origin URL, when the backend reports one. */
	readonly url: string | null
	/** How this integration can be authenticated, if at all. */
	readonly authMethods: readonly BrokerAuthMethod[]
}

export interface BrokerAuthMethod {
	readonly id: string
	readonly label: string
	/** `none` needs no credential; `api_key` takes a secret; `oauth` is Phase 2. */
	readonly kind: 'none' | 'api_key' | 'oauth' | 'other'
}

/** A workspace member's authenticated link to an integration. */
export interface BrokerConnection {
	/** Addressable identity of this connection, used by policies and patterns. */
	readonly address: string
	readonly integrationSlug: string
	readonly name: string
	/** `workspace` is visible to the whole workspace; `personal` only to its owner. */
	readonly scope: 'workspace' | 'personal'
}

/** The per-workspace tool surface exposed to agent sessions as one MCP endpoint. */
export interface WorkspaceToolkit {
	readonly id: string
	readonly slug: string
	readonly name: string
}

/** A provisioned per-actor identity on the broker, and its durable credential. */
export interface ProvisionedActor {
	readonly subjectId: string
	/**
	 * The actor's API key. The ONLY credential the caller should persist, and it
	 * must be encrypted at rest. Returned exactly once by the backend — it cannot
	 * be read back later.
	 */
	readonly apiKey: string
}

/** OAuth metadata discovered from a provider's endpoint. */
export interface OAuthMetadata {
	readonly issuer: string | null
	readonly authorizationUrl: string
	readonly tokenUrl: string
	readonly resource: string | null
	readonly scopesSupported: readonly string[] | null
	/** Present when the provider supports Dynamic Client Registration — the case
	 *  that needs no pre-registered app and no client secret. */
	readonly registrationEndpoint: string | null
	readonly tokenEndpointAuthMethodsSupported?: readonly string[]
}

export type BrokerAuthInput =
	| { readonly type: 'none' }
	| { readonly type: 'api_key'; readonly value: string }
	| { readonly type: 'oauth' }

/** The credential was rejected — a stale or revoked API key, or bad admin login. */
export class ToolBrokerAuthError extends Error {
	readonly kind = 'unauthorized' as const
	constructor(message: string) {
		super(message)
		this.name = 'ToolBrokerAuthError'
	}
}

/** The backend answered, but with a failure status. */
export class ToolBrokerHttpError extends Error {
	readonly kind = 'http' as const
	constructor(
		readonly status: number,
		readonly body: string,
		message?: string,
	) {
		super(message ?? `Tool broker returned ${status}`)
		this.name = 'ToolBrokerHttpError'
	}
}

/** The backend could not be reached at all. Callers should degrade, not fail. */
export class ToolBrokerUnavailableError extends Error {
	readonly kind = 'unavailable' as const
	constructor(cause: unknown) {
		super('Tool broker is unreachable')
		this.name = 'ToolBrokerUnavailableError'
		this.cause = cause
	}
}

/** A membership pattern we refuse to send because it would over-grant. */
export class ToolBrokerPatternError extends Error {
	readonly kind = 'unsafe_pattern' as const
	constructor(
		readonly pattern: string,
		reason: string,
	) {
		super(`Refusing to send toolkit membership pattern ${JSON.stringify(pattern)}: ${reason}`)
		this.name = 'ToolBrokerPatternError'
	}
}
