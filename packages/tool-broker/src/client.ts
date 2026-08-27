import {
	type BrokerAuthInput,
	type BrokerConnection,
	type BrokerIntegration,
	type ProvisionedActor,
	ToolBrokerAuthError,
	ToolBrokerHttpError,
	ToolBrokerPatternError,
	ToolBrokerUnavailableError,
	type WorkspaceToolkit,
} from './types'

// ---------------------------------------------------------------------------
// The tool broker client — the ONLY place in Maskin that speaks the backend's
// vocabulary. Callers pass workspace ids and actor ids; this file turns those
// into the backend's toolkits, subjects and glob patterns, and turns the
// answers back into Maskin terms.
//
// TWO CREDENTIAL PLANES, and they are not interchangeable. The backend accepts
// an API key on its product and MCP planes, but NOT on its account or admin
// planes — those resolve a session directly and reject keys with 401. So:
//
//   provisioning (invite + mint key) -> needs an ADMIN SESSION, from a password
//   everything at runtime            -> uses the ACTOR'S API KEY
//
// This is why `provisionActor` is the only method taking admin credentials and
// every other method takes an `apiKey`.
//
// WHAT WE DELIBERATELY DO NOT DO: we never persist a per-actor password. A
// password mints a full session, which would reach the account and admin planes
// for that user — a strictly larger capability than the API key carries. The
// generated password is used once, here, and discarded. Recovery is
// re-provisioning; rotation without a stored password is an open question.
// ---------------------------------------------------------------------------

export interface ToolBrokerClientDeps {
	readonly baseUrl: string
	/** Admin login, read from the environment at call time. Never stored in our DB. */
	readonly adminEmail: string
	readonly adminPassword: string
	readonly fetchImpl?: typeof fetch
}

interface RequestOptions {
	readonly method?: string
	readonly path: string
	readonly token?: string
	readonly body?: unknown
}

/**
 * Per-workspace prefix for every backend-side name a workspace owns.
 *
 * FIXED LENGTH, and IDENTIFIER-SAFE. The prefix is the workspace's UUID with
 * dashes removed — always 32 hex characters — then an underscore. Fixed length
 * keeps one workspace's prefix from ever being a prefix of another's. The
 * underscore matters because a tool address is evaluated as a JS expression in
 * code mode: `w<hex>_linear` can be written `tools.w<hex>_linear.…`, whereas a
 * hyphen would force bracket syntax.
 */
export const workspacePrefix = (workspaceId: string): string =>
	`w${workspaceId.replace(/-/g, '').toLowerCase()}_`

/**
 * The membership pattern admitting ONE integration into a workspace's toolkit.
 *
 * Patterns are SEGMENT-ALIGNED: a `*` replaces a whole dot-separated segment and
 * a partial-segment glob is rejected outright by the backend's validator
 * (`deepwiki.*` is accepted, `deep*` is "Invalid toolkit policy pattern"). So a
 * workspace cannot be admitted with one `<prefix>*` pattern; the prefix has to
 * ride inside a literal first segment, and membership is written per
 * integration. That is why membership grows with the integration list instead of
 * being a single row per workspace.
 */
export const integrationPattern = (slug: string): string => `${slug}.*`

/** Namespace a user-supplied integration name into the workspace's own space. */
export const workspaceScopedSlug = (workspaceId: string, name: string): string => {
	// Underscores, not hyphens, and that is not cosmetic: a tool address becomes a
	// JS expression in code mode, so `tools.<slug>.org.shared.tool()` only parses
	// when the slug is a valid identifier. A hyphen forces bracket syntax, which
	// agents reach for less readily — measured: the hyphenated form produced a
	// `tool_not_found` with an empty `suggestions` array.
	const safe = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
	return `${workspacePrefix(workspaceId)}${safe || 'integration'}`
}

/**
 * Refuse to emit a membership pattern that would over-grant.
 *
 * THE dangerous bug in this file. The backend accepts `*` as a membership
 * pattern without complaint, and a toolkit admitted with `*` reaches every
 * integration on the instance — every other workspace's included. An empty or
 * single-segment pattern is the same failure with a different spelling. Since
 * the toolkit endpoint is otherwise default-deny, this function is the thing
 * standing between a slug bug and a cross-workspace grant, so it throws rather
 * than sanitising: a pattern we cannot vouch for must not be sent at all.
 */
export const assertScopedPattern = (pattern: string): string => {
	const segments = pattern.split('.')
	if (pattern.trim() === '' || pattern === '*') {
		throw new ToolBrokerPatternError(pattern, 'grants every tool on the instance')
	}
	if (segments.length < 2) {
		throw new ToolBrokerPatternError(pattern, 'must have at least two segments')
	}
	const [first] = segments
	if (!first || first === '*' || first.includes('*')) {
		throw new ToolBrokerPatternError(pattern, 'first segment must be a literal, not a wildcard')
	}
	if (!/^w[0-9a-f]{32}_/.test(first)) {
		throw new ToolBrokerPatternError(pattern, 'first segment must carry a workspace prefix')
	}
	return pattern
}

/** Strip the prefix for display, so users never see our internal namespacing. */
export const displayNameFromSlug = (workspaceId: string, slug: string): string => {
	const prefix = workspacePrefix(workspaceId)
	return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug
}

export class ToolBrokerClient {
	private readonly baseUrl: string
	private readonly adminEmail: string
	private readonly adminPassword: string
	private readonly fetchImpl: typeof fetch

	constructor(deps: ToolBrokerClientDeps) {
		this.baseUrl = deps.baseUrl.replace(/\/+$/, '')
		this.adminEmail = deps.adminEmail
		this.adminPassword = deps.adminPassword
		this.fetchImpl = deps.fetchImpl ?? fetch
	}

	// -- transport ----------------------------------------------------------

	private async request<T>({ method = 'GET', path, token, body }: RequestOptions): Promise<T> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			// The backend's auth plane refuses a request with no Origin
			// (MISSING_OR_NULL_ORIGIN, 403) — a browser-shaped check that a
			// server-to-server caller trips even though curl does not. Sending our
			// own base URL satisfies it; without this, provisioning cannot sign in
			// at all.
			Origin: this.baseUrl,
		}
		if (token) headers.Authorization = `Bearer ${token}`
		if (body !== undefined) headers['Content-Type'] = 'application/json'

		let response: Response
		try {
			response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			})
		} catch (cause) {
			// A transport failure is not an application error: the caller should
			// carry on without broker tools rather than fail the whole operation.
			throw new ToolBrokerUnavailableError(cause)
		}

		if (response.status === 401 || response.status === 403) {
			throw new ToolBrokerAuthError(`Tool broker rejected the credential (${response.status})`)
		}
		if (!response.ok) {
			throw new ToolBrokerHttpError(response.status, await response.text().catch(() => ''))
		}
		if (response.status === 204) return undefined as T
		return (await response.json()) as T
	}

	/** Sign in as the instance admin. Short-lived, never persisted, never logged. */
	private async adminSession(): Promise<string> {
		const result = await this.request<{ token?: string }>({
			method: 'POST',
			path: '/api/auth/sign-in/email',
			body: { email: this.adminEmail, password: this.adminPassword },
		})
		if (!result.token) throw new ToolBrokerAuthError('Admin sign-in returned no session token')
		return result.token
	}

	// -- provisioning -------------------------------------------------------

	/**
	 * Create a backend identity for a Maskin actor and mint its API key.
	 *
	 * Idempotency is the CALLER's responsibility: this always creates a new
	 * identity, so persist the returned key and don't call it twice for the same
	 * actor. The backend returns the key exactly once and it cannot be read back.
	 *
	 * `generatePassword` is injected so tests stay deterministic; the default is
	 * a 32-byte CSPRNG value that exists only for the duration of this call.
	 */
	async provisionActor(input: {
		email: string
		displayName: string
		generatePassword?: () => string
	}): Promise<ProvisionedActor> {
		const adminToken = await this.adminSession()

		const invite = await this.request<{ code: string }>({
			method: 'POST',
			path: '/api/admin/invites',
			token: adminToken,
			body: { role: 'member' },
		})

		const password = (input.generatePassword ?? defaultPassword)()
		const signUp = await this.request<{ token?: string; user?: { id?: string } }>({
			method: 'POST',
			path: '/api/auth/sign-up/email',
			body: {
				name: input.displayName,
				email: input.email,
				password,
				inviteCode: invite.code,
			},
		})
		if (!signUp.token) throw new ToolBrokerAuthError('Sign-up returned no session token')

		// The key must be minted with the SESSION, not a key — the account plane
		// rejects API keys. After this point the password is never used again.
		const key = await this.request<{ value?: string }>({
			method: 'POST',
			path: '/api/account/api-keys',
			token: signUp.token,
			body: { name: 'maskin' },
		})
		if (!key.value) throw new ToolBrokerHttpError(200, '', 'API key response contained no value')

		return { subjectId: signUp.user?.id ?? input.email, apiKey: key.value }
	}

	// -- toolkits -----------------------------------------------------------

	/**
	 * Ensure the workspace's toolkit exists, and that its membership admits
	 * exactly this workspace's own integrations.
	 *
	 * Idempotent: an existing toolkit with the same slug is reused rather than
	 * duplicated, so two concurrent session launches converge on one toolkit.
	 */
	async ensureToolkit(
		apiKey: string,
		input: { workspaceId: string; name: string },
	): Promise<WorkspaceToolkit> {
		const slug = `tk-${workspacePrefix(input.workspaceId).replace(/_$/, '')}`

		const existing = await this.request<{ toolkits?: RawToolkit[] }>({
			path: '/api/toolkits',
			token: apiKey,
		})
		const found = existing.toolkits?.find((t) => t.slug === slug)
		const toolkit =
			found ??
			(await this.request<RawToolkit>({
				method: 'POST',
				path: '/api/toolkits',
				token: apiKey,
				body: { owner: 'org', slug, name: input.name },
			}))

		// NOTE: no membership is written here. Patterns are segment-aligned, so a
		// workspace cannot be admitted wholesale by one glob — membership is added
		// per integration by `admitIntegration`, as each one is connected. A fresh
		// toolkit therefore admits NOTHING, which is the correct default given the
		// endpoint is default-deny.
		return { id: toolkit.id, slug: toolkit.slug, name: toolkit.name }
	}

	/**
	 * Admit one integration's tools into the workspace's toolkit.
	 *
	 * Called when an integration is connected. The pattern is validated before it
	 * is sent: an over-broad pattern here would hand the whole instance to this
	 * workspace, and the backend accepts `*` without complaint.
	 */
	async admitIntegration(
		apiKey: string,
		input: { toolkitId: string; integrationSlug: string },
	): Promise<void> {
		const pattern = assertScopedPattern(integrationPattern(input.integrationSlug))
		await this.request({
			method: 'POST',
			path: `/api/toolkits/${input.toolkitId}/connections`,
			token: apiKey,
			body: { pattern },
		})
	}

	/** Remove an integration's tools from the toolkit, on disconnect. */
	async revokeIntegration(
		apiKey: string,
		input: { toolkitId: string; membershipId: string },
	): Promise<void> {
		await this.request({
			method: 'DELETE',
			path: `/api/toolkits/${input.toolkitId}/connections/${encodeURIComponent(input.membershipId)}`,
			token: apiKey,
		})
	}

	/** Path of the workspace's MCP endpoint, relative to the broker's base URL. */
	toolkitMcpPath(slug: string): string {
		return `/mcp/toolkits/${slug}`
	}

	// -- integrations -------------------------------------------------------

	/** Integrations belonging to this workspace. Others are filtered out entirely. */
	async listIntegrations(apiKey: string, workspaceId: string): Promise<BrokerIntegration[]> {
		const raw = await this.request<RawIntegration[]>({ path: '/api/integrations', token: apiKey })
		const prefix = workspacePrefix(workspaceId)
		return (
			raw
				// Built-ins are the backend's own management surface, not a user
				// integration. Filtering on `kind` rather than on a name keeps the
				// backend's identity out of this repo entirely.
				.filter((entry) => entry.kind !== 'built-in')
				.filter((entry) => entry.slug.startsWith(prefix))
				.map((entry) => ({
					slug: entry.slug,
					name: displayNameFromSlug(workspaceId, entry.slug),
					kind: entry.kind === 'openapi' ? 'openapi' : 'mcp',
					removable: entry.canRemove !== false,
					url: entry.displayUrl ?? null,
					authMethods: (entry.authMethods ?? []).map((method) => ({
						id: method.id,
						label: method.label,
						kind:
							method.kind === 'none' || method.kind === 'oauth'
								? method.kind
								: method.kind === 'api_key'
									? 'api_key'
									: 'other',
					})),
				}))
		)
	}

	/** Ingest an MCP server or OpenAPI spec by URL, namespaced to the workspace. */
	async addIntegrationByUrl(
		apiKey: string,
		input: { workspaceId: string; url: string; kind: 'mcp' | 'openapi'; name?: string },
	): Promise<{ slug: string }> {
		const slug = workspaceScopedSlug(input.workspaceId, input.name ?? hostnameOf(input.url))
		const path = input.kind === 'mcp' ? '/api/mcp/servers' : '/api/openapi/specs'
		const body =
			input.kind === 'mcp'
				? { slug, name: slug, endpoint: input.url, transport: 'remote', remoteTransport: 'auto' }
				: // The url variant keys the value as `url`; only the blob variant uses
					// `value`. Sending `value` here fails with a bare "Missing key".
					{ slug, name: slug, spec: { kind: 'url', url: input.url } }

		await this.request({ method: 'POST', path, token: apiKey, body })
		return { slug }
	}

	/** Attach a credential (or none) so the integration's tools become callable. */
	async connect(
		apiKey: string,
		input: {
			integrationSlug: string
			auth: BrokerAuthInput
			/** `workspace` shares with the whole workspace; `personal` stays private. */
			scope?: 'workspace' | 'personal'
		},
	): Promise<BrokerConnection> {
		const owner = input.scope === 'personal' ? 'user' : 'org'
		const name = input.scope === 'personal' ? 'personal' : 'shared'
		const raw = await this.request<RawConnection>({
			method: 'POST',
			path: '/api/connections',
			token: apiKey,
			body: {
				owner,
				name,
				integration: input.integrationSlug,
				template: input.auth.type === 'none' ? 'none' : 'api_key',
				// The backend requires EXACTLY ONE credential origin (`value`,
				// `values` or `from`) even when the template needs no secret —
				// omitting it fails with "Expected exactly one credential origin"
				// and an empty 400 body. So a no-auth connection sends an empty
				// `values` map rather than nothing at all.
				...(input.auth.type === 'api_key' ? { value: input.auth.value } : { values: {} }),
			},
		})
		return {
			address: raw.address,
			integrationSlug: raw.integration,
			name: raw.name,
			scope: raw.owner === 'user' ? 'personal' : 'workspace',
		}
	}

	async disconnect(
		apiKey: string,
		input: { integrationSlug: string; scope: 'workspace' | 'personal'; name: string },
	): Promise<void> {
		const owner = input.scope === 'personal' ? 'user' : 'org'
		await this.request({
			method: 'DELETE',
			path: `/api/connections/${owner}/${encodeURIComponent(input.integrationSlug)}/${encodeURIComponent(input.name)}`,
			token: apiKey,
		})
	}
}

// -- backend response shapes (private to this file) -------------------------

interface RawToolkit {
	id: string
	slug: string
	name: string
}

interface RawIntegration {
	slug: string
	name?: string
	kind?: string
	canRemove?: boolean
	displayUrl?: string
	authMethods?: Array<{ id: string; label: string; kind: string }>
}

interface RawConnection {
	owner: string
	name: string
	integration: string
	address: string
}

const defaultPassword = (): string => {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const hostnameOf = (url: string): string => {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return 'integration'
	}
}
