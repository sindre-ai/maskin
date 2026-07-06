import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import './extensions.js'
import { getAllModules, getModuleDefaultSettings } from '@maskin/module-sdk'
import {
	type CustomExtensionEntry,
	type WebAppTarget,
	buildWebAppHref,
	resolveWebAppBaseUrl,
	stripTrailingSlash,
} from '@maskin/shared'
import {
	RESOURCE_MIME_TYPE,
	registerAppTool as _registerAppTool,
	registerAppResource,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Cron } from 'croner'
import { type CursorState, decodeCursor, encodeCursor, toSnapshotAt } from './cursor.js'
import { applyResponseTokenCap } from './response-cap.js'
import {
	type SummaryRow,
	buildContentSummary,
	isResponseScopingEnabled,
} from './response-scoping.js'
import {
	MUTATION_TOOL_KINDS,
	type TelemetrySink,
	createDefaultSink,
	recordMutation,
	recordToolCall,
	recordToolCallResponseSize,
	recordWidgetEvent,
} from './telemetry.js'
import { tools } from './tools.js'

interface McpConfig {
	apiBaseUrl: string
	apiKey: string
	defaultWorkspaceId: string
	/** Path to the directory containing built MCP app HTML files */
	htmlBasePath?: string
	/** Transport the server is exposed over. Tailors user-facing setup hints. */
	transport?: 'stdio' | 'http'
	/**
	 * Public base URL of the Maskin web app, used by MCP card UIs to build deep
	 * links back to the workspace (e.g. "https://maskin.example.com" or
	 * "http://localhost:5173"). Threaded through `_meta.webAppBaseUrl` on every
	 * tool response so each rendered card can produce stable object URLs.
	 */
	webAppBaseUrl?: string
	/**
	 * Telemetry sink for `tool_call` and `mutation` events emitted on every
	 * tool response. Defaults to a fire-and-forget POST to /api/telemetry/mcp;
	 * tests inject capturing sinks and deployments without telemetry can pass
	 * a noop. The default never throws and never blocks tool calls.
	 */
	telemetrySink?: TelemetrySink
}

/**
 * Build the `_meta` envelope returned to MCP cards. Always includes `toolName`
 * so the card runtime can switch on it; optionally includes `webAppBaseUrl` +
 * `workspaceId` so cards can render deep links into the web app (X1 in the
 * MCP UI parity backlog).
 */
function meta(toolName: string, config: McpConfig, workspaceId?: string): Record<string, unknown> {
	const m: Record<string, unknown> = { toolName }
	if (config.webAppBaseUrl) m.webAppBaseUrl = stripTrailingSlash(config.webAppBaseUrl)
	const ws = workspaceId ?? config.defaultWorkspaceId
	if (ws) m.workspaceId = ws
	return m
}

/**
 * `meta()` plus a `ui` block. Use this when a response wants to override the
 * widget resource on a per-response basis (e.g. swap to the Hero Card when the
 * predicate fires) without changing the tool registration.
 */
function uiMeta(
	toolName: string,
	config: McpConfig,
	workspaceId: string | undefined,
	resourceUri: string,
): Record<string, unknown> {
	return { ...meta(toolName, config, workspaceId), ui: { resourceUri, csp: CSP } }
}

function addUrl(
	entity: Record<string, unknown>,
	config: McpConfig,
	workspaceId: string,
	target: WebAppTarget,
): Record<string, unknown> {
	// Hoist title/name to the front so they appear before id/url in JSON output.
	const { title, name, ...rest } = entity
	const ordered: Record<string, unknown> = {}
	if (title !== undefined) ordered.title = title
	if (name !== undefined) ordered.name = name
	Object.assign(ordered, rest)
	if (config.webAppBaseUrl) {
		ordered.url = buildWebAppHref(stripTrailingSlash(config.webAppBaseUrl), workspaceId, target)
	}
	return ordered
}

/**
 * Build the `content` text for a list/search tool response. When response
 * scoping is on, returns a lean markdown summary bounded by the summary
 * byte budget (AC-T2); when off, returns `JSON.stringify(fullPayload, null, 2)`
 * so the flag-off response is byte-identical to the pre-scoping shape
 * (AC-T4 partial). `structuredContent` (built by the caller) is never touched
 * either way — the full enriched payload always survives on the structured
 * channel.
 */
function buildListContentText(
	fullPayload: unknown,
	rows: SummaryRow[],
	emptyLabel: string,
): string {
	if (isResponseScopingEnabled()) {
		return buildContentSummary(rows, { emptyLabel })
	}
	return JSON.stringify(fullPayload, null, 2)
}

/** Default page size when response scoping is on and the caller did not
 *  pass an explicit limit. Kept in sync with `HERO_CARD_UI_PAGE_SIZE` — the
 *  UI has been paging at 25 for months, so an agent that opts into the flag
 *  gets responses shaped like what a human sees in the widget. */
const DEFAULT_SCOPED_PAGE_SIZE = 25

/** Hard cap the `/api/objects` list + search endpoints enforce on `limit`
 *  (`objectQuerySchema` / `searchObjectsSchema` in `@maskin/shared`). The
 *  cursor `+ 1` sentinel below must stay strictly under this ceiling, so
 *  the effective scoped page size is capped at `MAX - 1`. */
const LIST_ENDPOINT_MAX_LIMIT = 100

/**
 * Resolve the effective page size + cursor state for a list/search MCP
 * tool call. When response scoping is on and the caller passes neither
 * `limit` nor `cursor`, we cap the page at `DEFAULT_SCOPED_PAGE_SIZE`
 * (AC-U1). When a cursor is present, its snapshot + last-seen keyset are
 * threaded through to the API on every subsequent hop so an insert in
 * the underlying table mid-walk cannot leak into the stream (AC-T3).
 *
 * `fallbackLimit` is the pre-scoping default — the value the tool used
 * before the flag existed. Preserving it keeps the flag-off path
 * byte-identical.
 */
interface ResolvedPagination {
	/** Row cap forwarded to the API. */
	limit: number
	/** Decoded cursor when the caller passed one in; otherwise `null`. */
	cursor: CursorState | null
	/** Snapshot upper bound for the walk. On the first call this is the
	 *  server's current time; on subsequent calls it is the value carried
	 *  by the cursor so every hop shares one freeze. */
	snapshotAt: string
	/** Sort order the walk is opened in. Locked for the whole cursor
	 *  chain so the keyset predicate stays consistent. */
	order: 'asc' | 'desc'
}

function resolveListPagination(
	args: {
		limit?: number
		cursor?: string
	},
	fallbackLimit: number,
): ResolvedPagination {
	const scoped = isResponseScopingEnabled()
	const cursor = scoped ? decodeCursor(args.cursor) : null
	const requested =
		typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
			? args.limit
			: scoped
				? DEFAULT_SCOPED_PAGE_SIZE
				: fallbackLimit
	// Under scoping we fetch `requested + 1` to detect "has more"; the API's
	// list endpoints reject any `limit > LIST_ENDPOINT_MAX_LIMIT`, so cap the
	// effective page at `MAX - 1` to keep the sentinel within bounds. Flag-off
	// pays no such price — the URL sends exactly what the caller asked for.
	const limit = scoped ? Math.min(requested, LIST_ENDPOINT_MAX_LIMIT - 1) : requested
	const snapshotAt = cursor?.s ?? toSnapshotAt(new Date())
	const order = cursor?.o ?? 'desc'
	return { limit, cursor, snapshotAt, order }
}

/**
 * Encode the next-cursor for a list tool response. Returns `null` when
 * response scoping is off (the flag-off path must stay byte-identical) or
 * when the caller already reached the end of the walk — `rows.length <
 * limit + 1` means the API had nothing more to hand back.
 *
 * Reuses `snapshotAt` and `order` from `pagination`, so every hop of the
 * same walk agrees on the freeze even if the underlying `objects` table
 * accepts inserts between calls.
 */
function encodeNextCursor(
	pagination: ResolvedPagination,
	rows: Array<{ id: string; createdAt?: string | null }>,
): { nextCursor: string | null; trimmed: Array<{ id: string; createdAt?: string | null }> } {
	if (!isResponseScopingEnabled()) return { nextCursor: null, trimmed: rows }
	if (rows.length <= pagination.limit) return { nextCursor: null, trimmed: rows }
	const trimmed = rows.slice(0, pagination.limit)
	const last = trimmed[trimmed.length - 1]
	if (!last || !last.createdAt) return { nextCursor: null, trimmed }
	const nextCursor = encodeCursor({
		s: pagination.snapshotAt,
		o: pagination.order,
		k: { sortValue: last.createdAt, id: last.id },
	})
	return { nextCursor, trimmed }
}

/** Read `.url` off an enriched row without paying the TS cost each time. */
function pickUrl(row: unknown): string | undefined {
	if (!row || typeof row !== 'object') return undefined
	const u = (row as { url?: unknown }).url
	return typeof u === 'string' ? u : undefined
}

function authSetupHint(config: McpConfig): string {
	return config.transport === 'http'
		? 'Set an `Authorization: Bearer <YOUR_MASKIN_API_KEY>` header on the MCP request (see https://sindre.ai/docs/get-started/).'
		: 'Restart the MCP server with the API_KEY environment variable set.'
}

function workspaceSetupHint(config: McpConfig): string {
	return config.transport === 'http'
		? 'Either pass workspace_id to this tool or set an `X-Workspace-Id: <YOUR_WORKSPACE_ID>` header on the MCP request. Call list_workspaces to find your workspace ID.'
		: 'Either pass workspace_id to this tool, set DEFAULT_WORKSPACE_ID environment variable, or call list_workspaces to find your workspace ID.'
}

const __dirname = dirname(fileURLToPath(import.meta.url))

// Tool-to-resource URI mapping
const UI_RESOURCES = {
	objects: 'ui://maskin/objects',
	relationships: 'ui://maskin/relationships',
	actors: 'ui://maskin/actors',
	workspaces: 'ui://maskin/workspaces',
	events: 'ui://maskin/events',
	triggers: 'ui://maskin/triggers',
	graph: 'ui://maskin/graph',
	sessions: 'ui://maskin/sessions',
	schema: 'ui://maskin/schema',
	heroCard: 'ui://maskin/hero-card',
} as const

const CSP = {
	'font-src': ['https://fonts.gstatic.com'],
	'style-src': ['https://fonts.googleapis.com'],
} as const

type ApiCallOptions = {
	skipAuth?: boolean
	skipWorkspace?: boolean
	workspaceId?: string
	idempotencyKey?: string
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT'])

/**
 * Derive a deterministic Idempotency-Key from the host session id + the call
 * shape. When the MCP server runs inside an agent container, `SESSION_ID` is
 * injected by the host session-manager. A snapshotted session restored later
 * replays the same tool calls; deriving the key from `(sessionId, method, path,
 * sha256(body))` means the API ledger short-circuits the duplicate without
 * the agent having to thread a tool_use_id through.
 *
 * Returns `undefined` outside an agent session (no SESSION_ID) so a developer
 * running the MCP server locally does not accidentally dedup their own retries
 * across processes.
 */
export function deriveIdempotencyKey(
	method: string,
	path: string,
	body: unknown,
): string | undefined {
	const sessionId = process.env.SESSION_ID
	if (!sessionId) return undefined
	if (!MUTATING_METHODS.has(method)) return undefined
	const payload = body === undefined ? '' : JSON.stringify(body)
	const hash = createHash('sha256')
		.update(`${method}:${path}:${payload}`)
		.digest('hex')
		.slice(0, 32)
	return `mcp:${sessionId}:${hash}`
}

async function apiFetch(
	config: McpConfig,
	method: string,
	path: string,
	body?: unknown,
	options?: ApiCallOptions,
): Promise<Response> {
	if (!options?.skipAuth && !config.apiKey) {
		throw new Error(`Not authenticated. ${authSetupHint(config)}`)
	}
	const effectiveWorkspaceId = options?.workspaceId ?? config.defaultWorkspaceId
	if (!options?.skipAuth && !options?.skipWorkspace && !effectiveWorkspaceId) {
		throw new Error(`No workspace specified. ${workspaceSetupHint(config)}`)
	}

	const url = `${config.apiBaseUrl}${path}`
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	}
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`
	}
	if (effectiveWorkspaceId) {
		headers['X-Workspace-Id'] = effectiveWorkspaceId
	}
	const idempotencyKey = options?.idempotencyKey ?? deriveIdempotencyKey(method, path, body)
	if (idempotencyKey) {
		headers['Idempotency-Key'] = idempotencyKey
	}

	const response = await fetch(url, {
		method,
		headers,
		...(body ? { body: JSON.stringify(body) } : {}),
	})

	if (!response.ok) {
		const errorText = await response.text()
		let message: string
		try {
			const errorData = JSON.parse(errorText)
			if (errorData.error?.message) {
				const parts = [errorData.error.message]
				if (errorData.error.details?.length) {
					const fieldInfo = errorData.error.details
						.map(
							(d: { field: string; message: string; expected?: string }) =>
								`${d.field}: ${d.message}${d.expected ? ` (expected: ${d.expected})` : ''}`,
						)
						.join('; ')
					parts.push(`Fields: ${fieldInfo}`)
				}
				if (errorData.error.suggestion) {
					parts.push(`Hint: ${errorData.error.suggestion}`)
				}
				message = parts.join('. ')
			} else {
				message = errorText
			}
		} catch {
			message = errorText
		}
		throw new Error(`API error ${response.status}: ${message}`)
	}

	return response
}

async function apiCall(
	config: McpConfig,
	method: string,
	path: string,
	body?: unknown,
	options?: ApiCallOptions,
): Promise<unknown> {
	const response = await apiFetch(config, method, path, body, options)
	return response.json()
}

/**
 * Like `apiCall`, but also surfaces the response so callers can inspect
 * headers — e.g. paginated list tools reading `X-Total-Count` to populate
 * the heroCard `+N more` footer.
 */
async function apiCallWithResponse(
	config: McpConfig,
	method: string,
	path: string,
	body?: unknown,
	options?: ApiCallOptions,
): Promise<{ data: unknown; response: Response }> {
	const response = await apiFetch(config, method, path, body, options)
	return { data: await response.json(), response }
}

/** Parse an `X-Total-Count`-style header, falling back to a default. */
function parseTotalCountHeader(response: Response, fallback: number): number {
	const raw = response.headers.get('x-total-count')
	if (raw === null) return fallback
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

// Per-workspace mutex used to serialize read-modify-write tool calls (e.g.
// schema edits) within a single MCP process. Two MCP tool invocations from
// the same host targeting the same workspace will run sequentially, which
// eliminates lost-update races inside this process. Cross-process races
// still exist; callers that care must additionally verify after PATCH.
const workspaceLocks = new Map<string, Promise<unknown>>()

function withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
	const prev = workspaceLocks.get(workspaceId) ?? Promise.resolve()
	const result = prev.catch(() => undefined).then(fn)
	const lockEntry: Promise<unknown> = result
		.catch(() => undefined)
		.finally(() => {
			if (workspaceLocks.get(workspaceId) === lockEntry) workspaceLocks.delete(workspaceId)
		})
	workspaceLocks.set(workspaceId, lockEntry)
	return result
}

async function getWorkspace(
	config: McpConfig,
	workspaceId: string,
): Promise<{ id: string; name: string; settings: Record<string, unknown> }> {
	const workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
		skipWorkspace: true,
	})) as Array<{ id: string; name: string; settings: Record<string, unknown> }>
	const workspace = workspaces.find((w) => w.id === workspaceId)
	if (!workspace) throw new Error('Workspace not found')
	return workspace
}

function extractSettings(settings: Record<string, unknown>) {
	return {
		statuses: { ...((settings.statuses ?? {}) as Record<string, string[]>) },
		displayNames: { ...((settings.display_names ?? {}) as Record<string, string>) },
		fieldDefs: { ...((settings.field_definitions ?? {}) as Record<string, unknown[]>) },
		relTypes: [...((settings.relationship_types ?? []) as string[])],
		customExtensions: {
			...((settings.custom_extensions ?? {}) as Record<string, CustomExtensionEntry>),
		},
	}
}

/** Enable a module and merge its default settings into the workspace. Returns the updated settings object. */
function buildEnableModuleSettings(
	moduleId: string,
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const enabledModules = Array.isArray(settings.enabled_modules)
		? [...(settings.enabled_modules as string[])]
		: ['work']

	enabledModules.push(moduleId)

	const defaults = getModuleDefaultSettings(moduleId)
	const updatedSettings: Record<string, unknown> = {
		enabled_modules: enabledModules,
	}

	if (defaults) {
		const existingStatuses = (settings.statuses ?? {}) as Record<string, string[]>
		const existingDisplayNames = (settings.display_names ?? {}) as Record<string, string>
		const existingFieldDefs = (settings.field_definitions ?? {}) as Record<string, unknown[]>
		const existingRelTypes = (settings.relationship_types ?? []) as string[]

		if (defaults.statuses) {
			updatedSettings.statuses = { ...existingStatuses }
			for (const [type, sts] of Object.entries(defaults.statuses)) {
				if (!(type in existingStatuses)) {
					;(updatedSettings.statuses as Record<string, string[]>)[type] = sts
				}
			}
		}
		if (defaults.display_names) {
			updatedSettings.display_names = { ...existingDisplayNames }
			for (const [type, name] of Object.entries(defaults.display_names)) {
				if (!(type in existingDisplayNames)) {
					;(updatedSettings.display_names as Record<string, string>)[type] = name
				}
			}
		}
		if (defaults.field_definitions) {
			updatedSettings.field_definitions = { ...existingFieldDefs }
			for (const [type, fields] of Object.entries(defaults.field_definitions)) {
				if (!(type in existingFieldDefs)) {
					;(updatedSettings.field_definitions as Record<string, unknown[]>)[type] = fields
				}
			}
		}
		if (defaults.relationship_types) {
			updatedSettings.relationship_types = [
				...new Set([...existingRelTypes, ...defaults.relationship_types]),
			]
		}
	}

	return updatedSettings
}

/** Compute the set of relationship types still referenced by remaining extensions. */
function collectActiveRelTypes(
	settings: Record<string, unknown>,
	modules: Array<{ objectTypes: Array<{ defaultRelationshipTypes?: string[] }> }>,
): string[] {
	const active = new Set<string>()

	// Module relationship types
	for (const mod of modules) {
		for (const ot of mod.objectTypes) {
			if (ot.defaultRelationshipTypes) {
				for (const rt of ot.defaultRelationshipTypes) active.add(rt)
			}
		}
	}

	// Custom extension relationship types
	const customExts = (settings.custom_extensions ?? {}) as Record<string, CustomExtensionEntry>
	for (const ext of Object.values(customExts)) {
		if (ext.relationship_types) {
			for (const rt of ext.relationship_types) active.add(rt)
		}
	}

	// Always keep the built-in defaults
	for (const rt of ['informs', 'breaks_into', 'blocks', 'relates_to', 'duplicates']) {
		active.add(rt)
	}

	return [...active]
}

/**
 * Trim a string to a max length without slicing mid-codepoint, returning a
 * preview suitable for `resources/list` descriptions. Returns the empty
 * string when no input is provided.
 */
function makePreview(text: string | null | undefined, maxLen = 200): string {
	if (!text) return ''
	const trimmed = text.trim()
	if (trimmed.length <= maxLen) return trimmed
	// Slice on a UTF-16 boundary; trailing whitespace from a mid-word slice
	// is removed so the ellipsis sits flush with the last character.
	return `${trimmed.slice(0, maxLen).trimEnd()}…`
}

interface ObjectRow {
	id: string
	workspaceId: string
	type: string
	title: string | null
	content: string | null
	status: string
	updatedAt?: string
}

interface ActorRow {
	id: string
	type: 'human' | 'agent'
	name: string
	email?: string | null
	role?: string
}

interface TriggerRow {
	id: string
	workspaceId: string
	name: string
	type: string
	enabled: boolean
}

interface SessionRow {
	id: string
	actorId: string
	[key: string]: unknown
}

/**
 * Fetch all actors in a workspace and return a map from actor id → display name.
 * Failures are non-fatal — sessions still render, just without inline names.
 */
async function fetchActorNameMap(
	config: McpConfig,
	workspaceId: string,
): Promise<Record<string, string>> {
	try {
		const actors = (await apiCall(config, 'GET', '/api/actors', undefined, {
			workspaceId,
		})) as ActorRow[]
		const map: Record<string, string> = {}
		for (const a of actors) {
			if (a?.id && a?.name) map[a.id] = a.name
		}
		return map
	} catch {
		return {}
	}
}

/** Inline `actorName` on a session payload using the supplied id→name map. */
function attachActorName<T extends SessionRow>(session: T, names: Record<string, string>): T {
	if (!session?.actorId) return session
	const name = names[session.actorId]
	if (!name) return session
	return { ...session, actorName: name }
}

/**
 * Enrich a single session with `actorName` via a one-shot `GET /api/actors/:id`.
 * Cheaper than `fetchActorNameMap` for single-session tool calls.
 * Failures are non-fatal — returns the session unchanged.
 */
async function enrichSessionActorName<T extends SessionRow>(
	config: McpConfig,
	workspaceId: string | undefined,
	session: T,
): Promise<T> {
	if (!workspaceId || !session?.actorId) return session
	try {
		const actor = (await apiCall(config, 'GET', `/api/actors/${session.actorId}`, undefined, {
			workspaceId,
		})) as ActorRow
		if (actor?.name) return { ...session, actorName: actor.name }
	} catch {}
	return session
}

/**
 * Register MCP resources so the host (Claude Desktop / Claude.ai paperclip
 * picker, Cursor, etc.) can list and read Maskin objects. Resource URIs are
 * the same deep-link URLs the chat card and web app use, so the picker, the
 * card, and the workspace all agree on object identity.
 *
 * Without `webAppBaseUrl` we cannot form deep links — the registration is
 * skipped and `resources/list` returns nothing rather than emitting URIs that
 * don't resolve in the web app.
 */
function registerObjectResources(server: McpServer, config: McpConfig) {
	const baseUrl = config.webAppBaseUrl ? stripTrailingSlash(config.webAppBaseUrl) : undefined
	if (!baseUrl) return

	// ─── Unified objects (insight / bet / task / meeting / ...) ───
	const objectsTemplate = new ResourceTemplate(`${baseUrl}/{workspaceId}/objects/{objectId}`, {
		list: async () => {
			if (!config.apiKey || !config.defaultWorkspaceId) return { resources: [] }
			try {
				const objs = (await apiCall(config, 'GET', '/api/objects?limit=100', undefined, {
					workspaceId: config.defaultWorkspaceId,
				})) as ObjectRow[]
				return {
					resources: objs.map((o) => ({
						uri: buildWebAppHref(baseUrl, o.workspaceId, { kind: 'object', id: o.id }),
						name: o.title?.trim() || `Untitled ${o.type}`,
						description: `[${o.type} · ${o.status}] ${makePreview(o.content)}`.trim(),
						mimeType: 'application/json',
					})),
				}
			} catch (err) {
				console.error('[MCP] resources/list (objects) failed:', err)
				return { resources: [] }
			}
		},
	})

	server.registerResource(
		'maskin-object',
		objectsTemplate,
		{
			title: 'Maskin object',
			description:
				'Workspace objects (insight, bet, task, meeting, decision, document, …). Filter by type or status when listing — the picker can ask for "all bets" or "all open insights".',
		},
		async (uri, vars) => {
			const workspaceId = String(vars.workspaceId)
			const objectId = String(vars.objectId)
			const obj = (await apiCall(config, 'GET', `/api/objects/${objectId}`, undefined, {
				workspaceId,
			})) as ObjectRow
			const deepLink = buildWebAppHref(baseUrl, workspaceId, {
				kind: 'object',
				id: obj.id,
			})
			const payload = {
				id: obj.id,
				type: obj.type,
				title: obj.title ?? null,
				status: obj.status,
				preview: makePreview(obj.content),
				deepLink,
				workspaceId: obj.workspaceId,
			}
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: 'application/json',
						text: JSON.stringify(payload, null, 2),
					},
				],
			}
		},
	)

	// ─── Actors (humans + agents) ──────────────────────────────────
	const actorsTemplate = new ResourceTemplate(`${baseUrl}/{workspaceId}/agents/{actorId}`, {
		list: async () => {
			if (!config.apiKey || !config.defaultWorkspaceId) return { resources: [] }
			try {
				const actors = (await apiCall(config, 'GET', '/api/actors', undefined, {
					workspaceId: config.defaultWorkspaceId,
				})) as ActorRow[]
				return {
					resources: actors.map((a) => ({
						uri: buildWebAppHref(baseUrl, config.defaultWorkspaceId, {
							kind: 'actor',
							id: a.id,
						}),
						name: a.name || `${a.type}-${a.id.slice(0, 8)}`,
						description: `[${a.type}]${a.email ? ` ${a.email}` : ''}`,
						mimeType: 'application/json',
					})),
				}
			} catch (err) {
				console.error('[MCP] resources/list (actors) failed:', err)
				return { resources: [] }
			}
		},
	})

	server.registerResource(
		'maskin-actor',
		actorsTemplate,
		{
			title: 'Maskin actor',
			description: 'Workspace members and agents (humans + AI).',
		},
		async (uri, vars) => {
			const workspaceId = String(vars.workspaceId)
			const actorId = String(vars.actorId)
			const actor = (await apiCall(config, 'GET', `/api/actors/${actorId}`, undefined, {
				workspaceId,
			})) as ActorRow
			const deepLink = buildWebAppHref(baseUrl, workspaceId, {
				kind: 'actor',
				id: actor.id,
			})
			const payload = {
				id: actor.id,
				type: actor.type,
				name: actor.name,
				email: actor.email ?? null,
				deepLink,
				workspaceId,
			}
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: 'application/json',
						text: JSON.stringify(payload, null, 2),
					},
				],
			}
		},
	)

	// ─── Triggers ──────────────────────────────────────────────────
	const triggersTemplate = new ResourceTemplate(`${baseUrl}/{workspaceId}/triggers/{triggerId}`, {
		list: async () => {
			if (!config.apiKey || !config.defaultWorkspaceId) return { resources: [] }
			try {
				const triggers = (await apiCall(config, 'GET', '/api/triggers', undefined, {
					workspaceId: config.defaultWorkspaceId,
				})) as TriggerRow[]
				return {
					resources: triggers.map((t) => ({
						uri: buildWebAppHref(baseUrl, t.workspaceId, { kind: 'trigger', id: t.id }),
						name: t.name || `Trigger ${t.id.slice(0, 8)}`,
						description: `[${t.type} · ${t.enabled ? 'enabled' : 'disabled'}]`,
						mimeType: 'application/json',
					})),
				}
			} catch (err) {
				console.error('[MCP] resources/list (triggers) failed:', err)
				return { resources: [] }
			}
		},
	})

	server.registerResource(
		'maskin-trigger',
		triggersTemplate,
		{
			title: 'Maskin trigger',
			description: 'Cron / event-based automations that run agents.',
		},
		async (uri, vars) => {
			const workspaceId = String(vars.workspaceId)
			const triggerId = String(vars.triggerId)
			const trigger = (await apiCall(config, 'GET', `/api/triggers/${triggerId}`, undefined, {
				workspaceId,
			})) as TriggerRow
			const deepLink = buildWebAppHref(baseUrl, workspaceId, {
				kind: 'trigger',
				id: trigger.id,
			})
			const payload = {
				id: trigger.id,
				name: trigger.name,
				type: trigger.type,
				enabled: trigger.enabled,
				deepLink,
				workspaceId: trigger.workspaceId,
			}
			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: 'application/json',
						text: JSON.stringify(payload, null, 2),
					},
				],
			}
		},
	)
}

/** Extracts a workspace_id from tool args without coupling the wrapper to the schemas. */
function extractWorkspaceId(args: unknown): string | undefined {
	if (!args || typeof args !== 'object') return undefined
	const ws = (args as { workspace_id?: unknown }).workspace_id
	return typeof ws === 'string' ? ws : undefined
}

/**
 * Inspects a mutation tool response to decide whether it actually mutated
 * something. Tools like `update_objects` aggregate per-target outcomes, so we
 * count one mutation event per call when at least one inner item explicitly
 * reports success.
 *
 * Defaults to `false` for unrecognised shapes. Over-counting biases the bet's
 * "20% of sessions include at least one mutation" metric upward, so unknown
 * responses are treated as "not a confirmed mutation" rather than assuming
 * success.
 */
function isSuccessfulMutationResponse(response: unknown): boolean {
	if (!response || typeof response !== 'object') return false
	if ((response as { isError?: unknown }).isError === true) return false
	const content = (response as { content?: unknown }).content
	if (!Array.isArray(content) || content.length === 0) return false
	const first = content[0] as { type?: string; text?: string } | undefined
	if (!first || first.type !== 'text' || typeof first.text !== 'string') return false
	let parsed: unknown
	try {
		parsed = JSON.parse(first.text)
	} catch {
		return false
	}
	if (Array.isArray(parsed)) {
		// Per-target aggregation (update_objects-style). The call counts when
		// at least one entry explicitly reports success === true.
		return parsed.some((entry) => {
			if (!entry || typeof entry !== 'object') return false
			return (entry as { success?: unknown }).success === true
		})
	}
	if (parsed && typeof parsed === 'object') {
		const obj = parsed as { success?: unknown; error?: unknown; id?: unknown }
		if (obj.success === true) return true
		if (obj.success === false) return false
		// No explicit success flag — accept as confirmed only if the payload has
		// no `error` field and looks like a record (has an `id`). Anything else
		// stays uncounted.
		return obj.error == null && typeof obj.id === 'string'
	}
	return false
}

/** Best-effort object_type label for the mutation event. */
function extractObjectType(toolName: string, args: unknown): string | undefined {
	if (toolName === 'update_objects' || toolName === 'create_objects') return 'object'
	if (toolName === 'delete_object') return 'object'
	if (toolName === 'create_relationship' || toolName === 'delete_relationship')
		return 'relationship'
	if (toolName.startsWith('create_') || toolName.startsWith('update_')) {
		const kind = toolName.split('_')[1]
		if (kind) return kind
	}
	if (args && typeof args === 'object') {
		const ot = (args as { object_type?: unknown; type?: unknown }).object_type
		if (typeof ot === 'string') return ot
	}
	return undefined
}

// ─── Hero Card payload builders ────────────────────────────
//
// The widget reads `structuredContent.heroCard` and renders a single flat
// HeroCardObject — no per-type branches on the client. Per-type context is
// resolved here so new object types absorb with a sensible default.

export interface HeroCardActor {
	id: string
	name: string | null
	type: string | null
}

export interface HeroCardObject {
	id: string
	type: string
	title: string | null
	status: string | null
	driver: HeroCardActor | null
	contextLine: string
	badges?: string[]
	// Full detail fields — populated by get_actor, ignored by list display
	description?: string | null
	systemPrompt?: string | null
	tools?: Record<string, unknown> | null
	llmProvider?: string | null
	llmConfig?: Record<string, unknown> | null
	// Full detail fields — populated by list_triggers
	actionPrompt?: string | null
	config?: Record<string, unknown> | null
}

export type HeroCardKind = 'single' | 'list' | 'empty'

export interface HeroCardPayload {
	kind: HeroCardKind
	tool: string
	object?: HeroCardObject
	objects?: HeroCardObject[]
	totalCount?: number
	page?: {
		limit: number
		offset: number
		hasMore: boolean
	}
}

const HERO_CARD_UI_PAGE_SIZE = 25

interface RawObject {
	id: string
	type: string
	title?: string | null
	status?: string | null
	driver?: string | null
	createdAt?: string | null
	updatedAt?: string | null
	metadata?: Record<string, unknown> | null
}

/**
 * Schema-driven Hero Card metadata for an object type. Keeps render eligibility
 * + context line + meta + primary action as schema annotations so a new type
 * gets the full Hero Card surface by adding one entry — no widget edits, no
 * predicate edits.
 *
 * Mirrors `heroCardTypeAnnotationSchema` in `packages/shared/src/schemas/workspaces.ts`.
 */
export interface HeroCardTypeAnnotation {
	/**
	 * One-line context strategy. Known value: `'last touch + stage'` — renders
	 * `last touch {age} · {status}`. Unknown strategies fall back to the
	 * legacy per-type switch in `buildContextLine`.
	 */
	hero_card_context?: string
	hero_card_metas?: Array<{ label: string; field?: string }>
	primary_action?: { label: string; kind: string }
}

/**
 * Built-in Hero Card annotations for object types in the launch set. `bet`,
 * `task`, `insight`, `trigger` keep their legacy switch paths in
 * `buildContextLine` so this map is purely additive — workspaces can still
 * override per-type via `settings.hero_card`.
 *
 * The customer variant (T2 resolution: render both `organization` AND `person`
 * with the customer context line) lives here, so any future explicit
 * `customer` type drops in by adding one entry.
 */
export const HERO_CARD_TYPE_DEFAULTS: Record<string, HeroCardTypeAnnotation> = {
	organization: {
		hero_card_context: 'last touch + stage',
		hero_card_metas: [
			{ label: 'Stage', field: 'status' },
			{ label: 'Owner', field: 'owner' },
		],
		primary_action: { label: 'Open in Maskin', kind: 'open_object' },
	},
	person: {
		hero_card_context: 'last touch + stage',
		hero_card_metas: [
			{ label: 'Stage', field: 'status' },
			{ label: 'Owner', field: 'owner' },
		],
		primary_action: { label: 'Open in Maskin', kind: 'open_object' },
	},
}

/** Days between two ISO timestamps. Negative values clamp to 0. */
function daysBetween(fromIso: string | null | undefined, nowMs: number): number | null {
	if (!fromIso) return null
	const fromMs = Date.parse(fromIso)
	if (!Number.isFinite(fromMs)) return null
	return Math.max(0, Math.floor((nowMs - fromMs) / 86_400_000))
}

function ageLabel(fromIso: string | null | undefined, nowMs = Date.now()): string | null {
	const days = daysBetween(fromIso, nowMs)
	if (days === null) return null
	if (days === 0) return 'today'
	if (days === 1) return '1d ago'
	if (days < 30) return `${days}d ago`
	const months = Math.floor(days / 30)
	if (months < 12) return `${months}mo ago`
	const years = Math.floor(days / 365)
	return `${years}y ago`
}

/** Render one or more anchor tags as a single `anchor #3+#6` label. */
function anchorLabel(meta: Record<string, unknown> | null | undefined): string | null {
	if (!meta) return null
	const raw = meta.anchors ?? meta.anchor
	if (Array.isArray(raw)) {
		const tags = raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
		if (tags.length === 0) return null
		return `anchor ${tags.join('+')}`
	}
	if (typeof raw === 'string' && raw.length > 0) return `anchor ${raw}`
	return null
}

/**
 * Per-type one-line context. Schema annotations (`HeroCardTypeAnnotation.hero_card_context`)
 * take precedence — a type with `'last touch + stage'` renders `last touch {age} · {status}`
 * regardless of which concrete type it is. Falls through to the legacy per-type
 * switch for `bet`/`task`/`insight` and to `type · status` for everything else,
 * so absorbing a new object type does NOT require a widget change.
 */
export function buildContextLine(
	obj: RawObject,
	driver: HeroCardActor | null,
	nowMs = Date.now(),
	annotations: Record<string, HeroCardTypeAnnotation> = HERO_CARD_TYPE_DEFAULTS,
): string {
	const status = obj.status ?? 'unknown'
	const annotation = annotations[obj.type]
	if (annotation?.hero_card_context === 'last touch + stage') {
		const lastTouch = obj.updatedAt ?? obj.createdAt
		const age = ageLabel(lastTouch, nowMs)
		return age ? `last touch ${age} · ${status}` : status
	}
	const age = ageLabel(obj.createdAt, nowMs)
	const driverName = driver?.name
	switch (obj.type) {
		case 'bet': {
			const duration = (obj.metadata?.duration_weeks ?? obj.metadata?.duration) as
				| string
				| number
				| undefined
			const durationLabel =
				typeof duration === 'number'
					? `${duration}-week bet`
					: typeof duration === 'string' && duration.length > 0
						? duration
						: age
							? `created ${age}`
							: null
			return durationLabel ? `${status} · ${durationLabel}` : status
		}
		case 'task':
			return driverName ? `${status} · driver ${driverName}` : status
		case 'insight': {
			const cluster = obj.metadata?.cluster_size as number | undefined
			const evidence = obj.metadata?.evidence_quality as string | undefined
			const anchor = anchorLabel(obj.metadata)
			const parts = [status]
			if (anchor) parts.push(anchor)
			if (typeof cluster === 'number') parts.push(`${cluster} sources`)
			else if (evidence) parts.push(evidence)
			return parts.join(' · ')
		}
		default:
			return age ? `${obj.type} · ${status} · ${age}` : `${obj.type} · ${status}`
	}
}

export function buildHeroCardObject(
	obj: RawObject,
	driver: HeroCardActor | null,
	nowMs = Date.now(),
	annotations: Record<string, HeroCardTypeAnnotation> = HERO_CARD_TYPE_DEFAULTS,
): HeroCardObject {
	return {
		id: obj.id,
		type: obj.type,
		title: obj.title ?? null,
		status: obj.status ?? null,
		driver,
		contextLine: buildContextLine(obj, driver, nowMs, annotations),
	}
}

/**
 * Per-response resource swap. Returns the Hero Card resource for single results
 * whose type is either in the built-in launch set (`bet`, `task`, `insight`,
 * `trigger`) or has a Hero Card annotation (customer variant: `organization`,
 * `person`, and any future schema-annotated type). Everything else stays on the
 * existing `objects` widget. New variants opt in by extending
 * `HERO_CARD_SINGLE_TYPES` or by adding an annotation.
 */
const HERO_CARD_SINGLE_TYPES: ReadonlySet<string> = new Set(['bet', 'task', 'insight', 'trigger'])

export function pickResourceUri(
	payload: HeroCardPayload,
	annotations: Record<string, HeroCardTypeAnnotation> = HERO_CARD_TYPE_DEFAULTS,
): string {
	if (payload.kind !== 'single' || !payload.object) return UI_RESOURCES.objects
	const type = payload.object.type
	if (HERO_CARD_SINGLE_TYPES.has(type) || annotations[type]) return UI_RESOURCES.heroCard
	return UI_RESOURCES.objects
}

/**
 * Collection tools always render through the Hero Card bundle: the same
 * widget handles the 0 / 1 / N branches and keeps the iframe payload
 * inside Anthropic's 500px envelope without a second template.
 */
function pickCollectionResourceUri(_payload: HeroCardPayload): string {
	return UI_RESOURCES.heroCard
}

interface RawActor {
	id: string
	type?: string | null
	name?: string | null
	email?: string | null
	role?: string | null
	isSystem?: boolean | null
	description?: string | null
	system_prompt?: string | null
	tools?: Record<string, unknown> | null
	llm_provider?: string | null
	llm_config?: Record<string, unknown> | null
}

interface RawWorkspace {
	id: string
	name?: string | null
	role?: string | null
	createdAt?: string | null
	updatedAt?: string | null
}

function buildActorContextLine(actor: RawActor): string {
	const kind = actor.type || 'actor'
	const parts: string[] = [kind]
	if (actor.role) parts.push(actor.role)
	else if (actor.email) parts.push(actor.email)
	return parts.join(' · ')
}

function buildActorHeroCardObject(actor: RawActor, includeDetails = false): HeroCardObject {
	const status = actor.isSystem ? 'system' : (actor.role ?? actor.type ?? null)
	const obj: HeroCardObject = {
		id: actor.id,
		type: 'actor',
		title: actor.name ?? null,
		status,
		driver: null,
		contextLine: buildActorContextLine(actor),
	}
	if (includeDetails) {
		obj.description = actor.description ?? null
		obj.systemPrompt = actor.system_prompt ?? null
		obj.tools = actor.tools ?? null
		obj.llmProvider = actor.llm_provider ?? null
		obj.llmConfig = actor.llm_config ?? null
	}
	return obj
}

function buildWorkspaceContextLine(workspace: RawWorkspace): string {
	const age = ageLabel(workspace.updatedAt ?? workspace.createdAt)
	const parts = ['workspace']
	if (age) parts.push(age)
	return parts.join(' · ')
}

function buildWorkspaceHeroCardObject(workspace: RawWorkspace): HeroCardObject {
	return {
		id: workspace.id,
		type: 'workspace',
		title: workspace.name ?? null,
		status: workspace.role ?? 'active',
		driver: null,
		contextLine: buildWorkspaceContextLine(workspace),
	}
}

/**
 * Build the heroCard payload for a list-style tool response. Collapses to
 * `single` when the result has exactly one row so the predicate can fire on
 * single-result `list_objects` / `search_objects` calls too.
 */
async function buildCollectionHeroCard(
	config: McpConfig,
	tool: string,
	rows: RawObject[],
	workspaceId: string | undefined,
	totalCount = rows.length,
	offset = 0,
): Promise<HeroCardPayload> {
	if (!Array.isArray(rows) || rows.length === 0) return { kind: 'empty', tool }
	const driverIds = rows.map((o) => o.driver).filter((v): v is string => typeof v === 'string')
	const actors = await resolveActors(config, driverIds, workspaceId)
	const heroObjects = rows.map((o) =>
		buildHeroCardObject(o, o.driver ? (actors.get(o.driver) ?? null) : null),
	)
	if (heroObjects.length === 1) return { kind: 'single', tool, object: heroObjects[0] }
	const uiObjects = heroObjects.slice(0, HERO_CARD_UI_PAGE_SIZE)
	return {
		kind: 'list',
		tool,
		objects: uiObjects,
		totalCount,
		page: {
			limit: uiObjects.length,
			offset,
			hasMore: offset + uiObjects.length < totalCount,
		},
	}
}

interface RawTrigger {
	id: string
	name: string
	type: string
	config: Record<string, unknown> | null
	enabled: boolean
	targetActorId?: string | null
	target_actor_id?: string | null
	createdAt?: string | null
	updatedAt?: string | null
	actionPrompt?: string | null
}

function formatRelativeFuture(targetMs: number, nowMs: number): string {
	const diffMs = targetMs - nowMs
	if (diffMs <= 0) return 'due now'
	const minutes = Math.floor(diffMs / 60_000)
	if (minutes < 60) return `in ${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `in ${hours}h`
	const days = Math.floor(hours / 24)
	if (days < 30) return `in ${days}d`
	const months = Math.floor(days / 30)
	return `in ${months}mo`
}

/**
 * Per-trigger-type context line: schedule + next-run for cron, scheduled time
 * for reminder, event predicate for event triggers. Uses `croner` purely for
 * next-run lookup — no shared scheduler state.
 */
function buildTriggerContextLine(trigger: RawTrigger, nowMs = Date.now()): string {
	const enabledLabel = trigger.enabled ? 'enabled' : 'disabled'
	const config = trigger.config ?? {}
	switch (trigger.type) {
		case 'cron': {
			const expression = typeof config.expression === 'string' ? config.expression : null
			if (!expression) return `cron · ${enabledLabel}`
			// Cron triggers fire in UTC (see `scheduleCron` in apps/dev/src/services/trigger-runner.ts).
			// Workspaces don't carry a timezone yet, so we surface UTC inline to keep the
			// label honest against the runtime; drop the suffix once timezone is plumbed through.
			let nextLabel: string | null = null
			if (trigger.enabled) {
				try {
					const job = new Cron(expression, { timezone: 'UTC' })
					const next = job.nextRun(new Date(nowMs))
					if (next) nextLabel = `next ${formatRelativeFuture(next.getTime(), nowMs)}`
				} catch {
					// Invalid expression — skip next-run, keep the schedule line.
				}
			}
			const schedule = `${expression} (UTC)`
			return nextLabel
				? `${enabledLabel} · ${schedule} · ${nextLabel}`
				: `${enabledLabel} · ${schedule}`
		}
		case 'reminder': {
			const scheduledAt = typeof config.scheduled_at === 'string' ? config.scheduled_at : null
			if (!scheduledAt) return `reminder · ${enabledLabel}`
			const targetMs = Date.parse(scheduledAt)
			if (!Number.isFinite(targetMs)) return `reminder · ${enabledLabel}`
			return `${enabledLabel} · at ${scheduledAt} · ${formatRelativeFuture(targetMs, nowMs)}`
		}
		case 'event': {
			const action = typeof config.action === 'string' ? config.action : null
			const entityType = typeof config.entity_type === 'string' ? config.entity_type : null
			if (action && entityType) return `${enabledLabel} · on ${action} ${entityType}`
			if (action) return `${enabledLabel} · on ${action}`
			return `event · ${enabledLabel}`
		}
		default:
			return `${trigger.type} · ${enabledLabel}`
	}
}

function buildTriggerHeroCardObject(
	trigger: RawTrigger,
	driver: HeroCardActor | null,
	nowMs = Date.now(),
): HeroCardObject {
	return {
		id: trigger.id,
		type: 'trigger',
		title: trigger.name ?? null,
		status: trigger.enabled ? 'enabled' : 'disabled',
		driver,
		contextLine: buildTriggerContextLine(trigger, nowMs),
		actionPrompt: trigger.actionPrompt ?? null,
		config: trigger.config,
	}
}

/**
 * Resolve actor names and types for a set of actor IDs in one shot. Used to
 * fill driver info into HeroCardObject. Best-effort: missing actors come back
 * as `{ id, name: null, type: null }` so the widget renders without driver instead of failing.
 */
// Hero-card responses typically resolve a single tool call's owner set (≤50
// objects). Cap defensively at 200 to match the server-side `?ids=` limit and
// avoid building an URL larger than the receiver accepts.
const RESOLVE_ACTORS_MAX_IDS = 200

async function resolveActors(
	config: McpConfig,
	actorIds: Iterable<string>,
	workspaceId: string | undefined,
): Promise<Map<string, HeroCardActor>> {
	const uniq = [...new Set([...actorIds].filter((id): id is string => typeof id === 'string'))]
	const out = new Map<string, HeroCardActor>()
	if (uniq.length === 0) return out
	const queryIds = uniq.slice(0, RESOLVE_ACTORS_MAX_IDS)
	try {
		const query = `?ids=${queryIds.map(encodeURIComponent).join(',')}`
		const result = (await apiCall(config, 'GET', `/api/actors${query}`, undefined, {
			workspaceId,
		})) as Array<{ id: string; name: string | null; type?: string | null }>
		for (const a of result) out.set(a.id, { id: a.id, name: a.name ?? null, type: a.type ?? null })
		console.log(
			`[MCP] Resolved ${out.size}/${queryIds.length} hero-card actor names (requested ${uniq.length})`,
		)
	} catch (err) {
		console.error('[MCP] Failed to resolve actors for hero-card:', err)
	}
	for (const id of uniq) {
		if (!out.has(id)) out.set(id, { id, name: null, type: null })
	}
	return out
}

function loadHtml(config: McpConfig, filename: string): string {
	const basePath = config.htmlBasePath ?? resolve(__dirname, '../../../apps/web/dist-mcp')
	const fullPath = resolve(basePath, filename)
	try {
		const html = readFileSync(fullPath, 'utf-8')
		console.log(`[MCP] Loaded HTML resource: ${filename} (${html.length} bytes) from ${fullPath}`)
		return html
	} catch (err) {
		console.error(`[MCP] Failed to load HTML resource: ${fullPath}`, err)
		return '<html><body><p>MCP App UI not built yet. Run <code>pnpm --filter @maskin/web build:mcp</code> first.</p></body></html>'
	}
}

export function createMcpServer(config: McpConfig) {
	const server = new McpServer({
		name: 'maskin',
		version: '0.1.0',
	})

	const telemetrySink: TelemetrySink = config.telemetrySink ?? createDefaultSink()
	const telemetryTarget = {
		apiBaseUrl: config.apiBaseUrl,
		apiKey: config.apiKey,
		workspaceId: config.defaultWorkspaceId,
	}

	// Telemetry-instrumented tool registration. Wraps the upstream
	// `registerAppTool` so every tool response emits a `tool_call` telemetry
	// event (rich-render % numerator/denominator) and successful mutations
	// emit an additional `mutation` event. Failures inside the original
	// handler are re-thrown unchanged so MCP error semantics are preserved.
	//
	// We deliberately type as `any` at the boundary because ext-apps' generic
	// tool signature can't be re-introduced through a higher-order wrapper
	// without losing the per-tool input schema inference; the wrapper is purely
	// pass-through so giving up the wrapper's signature is safe.
	// biome-ignore lint/suspicious/noExplicitAny: see comment above.
	const registerAppTool = ((s: any, name: string, definition: any, handler: any) => {
		const defHasRichRender = Boolean(definition?._meta?.ui)
		const mutationKind = MUTATION_TOOL_KINDS[name]

		const wrappedHandler = async (args: unknown, extra: unknown) => {
			const start = Date.now()
			let response: unknown
			try {
				response = await handler(args, extra)
			} catch (err) {
				recordToolCall(telemetrySink, telemetryTarget, {
					tool_name: name,
					has_rich_render: defHasRichRender,
					duration_ms: Date.now() - start,
					workspace_id: extractWorkspaceId(args),
				})
				throw err
			}

			const responseMeta = (response as { _meta?: { ui?: unknown } } | undefined)?._meta
			const responseHasRichRender =
				defHasRichRender || Boolean(responseMeta && 'ui' in responseMeta)

			recordToolCall(telemetrySink, telemetryTarget, {
				tool_name: name,
				has_rich_render: responseHasRichRender,
				duration_ms: Date.now() - start,
				workspace_id: extractWorkspaceId(args),
			})

			// Token-cap guardrail (T4). Enforces `MAX_RESPONSE_TOKENS` before the
			// telemetry event measures the shipped payload — the size event and
			// the wire response see the same, capped shape. Skipped when scoping
			// is off so AC-T4 flag-off byte parity holds.
			const scoped = isResponseScopingEnabled()
			const capped = scoped ? applyResponseTokenCap(name, response) : { response, truncated: false }
			const finalResponse = capped.response

			// Response-size baseline for the MCP response-scoping bet's First test.
			// Measures the two channels MCP serializes onto the wire — `content`
			// (always present) and `structuredContent` (optional). `truncated`
			// flips true when the token-cap wrapper dropped rows. Fires uniformly
			// for every tool because we sit inside the single `registerAppTool`
			// integration point.
			const responseShape = finalResponse as
				| { content?: unknown; structuredContent?: unknown }
				| undefined
			recordToolCallResponseSize(telemetrySink, telemetryTarget, {
				tool_name: name,
				content: responseShape?.content,
				structured_content: responseShape?.structuredContent,
				truncated: capped.truncated,
				workspace_id: extractWorkspaceId(args),
			})

			if (mutationKind && isSuccessfulMutationResponse(finalResponse)) {
				recordMutation(telemetrySink, telemetryTarget, {
					tool_name: name,
					mutation_kind: mutationKind,
					object_type: extractObjectType(name, args),
					workspace_id: extractWorkspaceId(args),
				})
			}

			return finalResponse
		}

		// biome-ignore lint/suspicious/noExplicitAny: handler signature varies by inputSchema presence; the wrapper is a pure pass-through so we forward as-is.
		return _registerAppTool(s, name, definition, wrappedHandler as any)
		// biome-ignore lint/suspicious/noExplicitAny: see comment above.
	}) as any as typeof _registerAppTool

	// ─── Register UI resources ─────────────────────────────────
	// Filename is derived from the URI's last path segment so kebab-case bundles
	// (e.g. `hero-card.html`) can register under camelCase keys (`heroCard`).
	for (const [name, uri] of Object.entries(UI_RESOURCES)) {
		const filename = `${uri.split('/').pop()}.html`
		registerAppResource(server, `${name}-ui`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
			console.log(`[MCP] Resource read requested: ${uri} (${filename})`)
			return {
				contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: loadHtml(config, filename) }],
			}
		})
	}

	// ─── Register data resources for the picker ────────────────
	registerObjectResources(server, config)

	// ─── Objects ───────────────────────────────────────────────
	registerAppTool(
		server,
		'create_objects',
		{
			description: tools.create_objects.description,
			inputSchema: tools.create_objects.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, nodes, edges } = args
			const wsOpts = { workspaceId: workspace_id }

			// /api/graph doesn't understand file_ids — strip them from the body
			// and replay each node's file_ids as `attached` relationships after
			// the graph is created. Keeps the backend schema unchanged.
			const fileIdsByDollarId = new Map<string, string[]>()
			const nodesForApi = nodes.map((node) => {
				const { file_ids, ...rest } = node
				if (file_ids?.length) fileIdsByDollarId.set(node.$id, file_ids)
				return rest
			})

			const graphResult = (await apiCall(
				config,
				'POST',
				'/api/graph',
				{ nodes: nodesForApi, edges },
				wsOpts,
			)) as {
				nodes: Array<{ id: string; type: string; $id: string }>
				edges: unknown[]
			}

			// Map each created node's $id → real UUID + type so we can fan out
			// `attached` relationships pointing at the requested file_ids.
			const fileAttachments: Array<{
				type: 'file_attachment'
				id: string
				success: boolean
				result?: unknown
				error?: string
			}> = []
			if (fileIdsByDollarId.size > 0) {
				const tasks: Array<Promise<void>> = []
				for (const node of graphResult.nodes) {
					const fileIds = fileIdsByDollarId.get(node.$id)
					if (!fileIds?.length) continue
					for (const fileId of fileIds) {
						tasks.push(
							(async () => {
								try {
									const result = await apiCall(
										config,
										'POST',
										'/api/relationships',
										{
											source_type: node.type,
											source_id: node.id,
											target_type: 'file',
											target_id: fileId,
											type: 'attached',
										},
										wsOpts,
									)
									fileAttachments.push({
										type: 'file_attachment',
										id: `${node.id}->${fileId}`,
										success: true,
										result,
									})
								} catch (error) {
									fileAttachments.push({
										type: 'file_attachment',
										id: `${node.id}->${fileId}`,
										success: false,
										error: String(error),
									})
								}
							})(),
						)
					}
				}
				await Promise.all(tasks)
			}

			const wsId = workspace_id ?? config.defaultWorkspaceId
			const enrichedNodes =
				wsId && Array.isArray(graphResult.nodes)
					? graphResult.nodes.map((node) =>
							addUrl(node as Record<string, unknown>, config, wsId, {
								kind: 'object',
								id: node.id,
							}),
						)
					: graphResult.nodes
			const enrichedResult = { ...graphResult, nodes: enrichedNodes }
			const responseBody = fileAttachments.length
				? { ...enrichedResult, file_attachments: fileAttachments }
				: enrichedResult

			return {
				_meta: meta('create_objects', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(responseBody, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_objects',
		{
			description: tools.get_objects.description,
			inputSchema: tools.get_objects.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, include } = args
			const includeSet = new Set(include ?? [])
			const results = await Promise.all(
				args.ids.map(async (id) => {
					try {
						const result = await apiCall(config, 'GET', `/api/objects/${id}/graph`, undefined, {
							workspaceId: workspace_id,
						})
						return { id, success: true, result }
					} catch (error) {
						return { id, success: false, error: String(error) }
					}
				}),
			)

			// Build the Hero Card payload. Single successful result → kind='single'
			// (eligible to swap to the Hero Card widget); anything else stays
			// 'list' / 'empty' and renders via the existing objects widget.
			const successful = results.filter(
				(r): r is { id: string; success: true; result: { object: RawObject } } =>
					r.success === true && (r.result as { object?: unknown } | null)?.object != null,
			)
			const rawObjects = successful.map((r) => r.result.object)
			const driverIds = rawObjects
				.map((o) => o.driver)
				.filter((v): v is string => typeof v === 'string')
			const actors = await resolveActors(config, driverIds, workspace_id)
			const heroObjects = rawObjects.map((o) =>
				buildHeroCardObject(o, o.driver ? (actors.get(o.driver) ?? null) : null),
			)
			const contextLineById = new Map(heroObjects.map((h) => [h.id, h.contextLine]))
			const heroCard: HeroCardPayload =
				heroObjects.length === 0
					? { kind: 'empty', tool: 'get_objects' }
					: heroObjects.length === 1
						? { kind: 'single', tool: 'get_objects', object: heroObjects[0] }
						: {
								kind: 'list',
								tool: 'get_objects',
								objects: heroObjects.slice(0, HERO_CARD_UI_PAGE_SIZE),
								totalCount: heroObjects.length,
								page: {
									limit: Math.min(heroObjects.length, HERO_CARD_UI_PAGE_SIZE),
									offset: 0,
									hasMore: heroObjects.length > HERO_CARD_UI_PAGE_SIZE,
								},
							}

			const wsId = workspace_id ?? config.defaultWorkspaceId
			// Default projection: strip every graph field except the core seven
			// (`id, type, title, status, contextLine, url, workspaceId`) so the LLM's
			// context isn't paid to carry relationships/connected_objects/events/files/
			// content/metadata the caller didn't ask for. `workspaceId` stays in the
			// core set (unlike the other fields) because it's a small id, not bulky
			// content, and callers/widgets need it to route follow-up requests.
			// `include:` opt-in expansions are wired in T4.
			const projectedResults = results.map((r) => {
				if (!r.success) return r
				const graph = r.result as Record<string, unknown> | null | undefined
				const rawObj = graph?.object as Record<string, unknown> | undefined
				if (!rawObj) return r
				const withUrl = wsId
					? addUrl(rawObj, config, wsId, { kind: 'object', id: rawObj.id as string })
					: rawObj
				const projectedObject: Record<string, unknown> = {
					id: withUrl.id,
					type: withUrl.type,
					title: withUrl.title ?? null,
					status: withUrl.status ?? null,
					contextLine: contextLineById.get(withUrl.id as string) ?? '',
					workspaceId: withUrl.workspaceId,
				}
				if (typeof withUrl.url === 'string') projectedObject.url = withUrl.url
				if (includeSet.has('content') && 'content' in withUrl) {
					projectedObject.content = withUrl.content
				}
				if (includeSet.has('metadata') && 'metadata' in withUrl) {
					projectedObject.metadata = withUrl.metadata
				}
				const extras: Record<string, unknown> = {}
				if (includeSet.has('relationships') && graph && 'relationships' in graph) {
					extras.relationships = graph.relationships
				}
				if (includeSet.has('connected_objects') && graph && 'connected_objects' in graph) {
					extras.connected_objects = graph.connected_objects
				}
				if (includeSet.has('events') && graph && 'events' in graph) {
					extras.events = graph.events
				}
				if (includeSet.has('files') && graph && 'files' in graph) {
					extras.files = graph.files
				}
				return { ...r, result: { object: projectedObject, ...extras } }
			})

			// Object body lives at `structuredContent.objects[]` only (ADR-0001).
			// `results[]` is a per-id success/error envelope so the same body isn't
			// duplicated across `results[].result.object` and `objects[].object`.
			const slimResults = projectedResults.map((r) =>
				r.success
					? { id: r.id, success: true as const }
					: { id: r.id, success: false as const, error: r.error },
			)
			const canonicalObjects = projectedResults
				.filter(
					(r): r is { id: string; success: true; result: { object: Record<string, unknown> } } =>
						r.success === true && (r.result as { object?: unknown } | null)?.object != null,
				)
				.map((r) => r.result)

			return {
				_meta: uiMeta('get_objects', config, workspace_id, pickResourceUri(heroCard)),
				content: [{ type: 'text' as const, text: JSON.stringify(projectedResults, null, 2) }],
				structuredContent: {
					heroCard,
					results: slimResults,
					objects: canonicalObjects,
				},
			}
		},
	)

	registerAppTool(
		server,
		'update_objects',
		{
			description: tools.update_objects.description,
			inputSchema: tools.update_objects.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const { workspace_id } = args
			const wsOpts = { workspaceId: workspace_id }
			const results: Array<{
				type: string
				id?: string
				success: boolean
				skipped?: boolean
				result?: unknown
				error?: string
			}> = []

			// Update objects in parallel
			if (args.updates?.length) {
				const objectResults = await Promise.all(
					args.updates.map(async ({ id, attach_file_ids, detach_file_ids, ...body }) => {
						const out: Array<{
							type: string
							id: string
							success: boolean
							skipped?: boolean
							result?: unknown
							error?: string
						}> = []

						// Captured from the PATCH response (when present) so attach_file_ids
						// can use the object's real type ('bet' | 'task' | 'insight') as
						// source_type — matching what create_objects and the web UI write.
						let objectType: string | undefined

						const hasFieldUpdate = Object.values(body).some((v) => v !== undefined)
						if (hasFieldUpdate) {
							try {
								const result = await apiCall(config, 'PATCH', `/api/objects/${id}`, body, wsOpts)
								objectType = (result as { type?: unknown })?.type as string | undefined
								const urlWsId = wsOpts.workspaceId ?? config.defaultWorkspaceId
								out.push({
									type: 'object',
									id,
									success: true,
									result: urlWsId
										? addUrl(result as Record<string, unknown>, config, urlWsId, {
												kind: 'object',
												id,
											})
										: result,
								})
							} catch (error) {
								out.push({ type: 'object', id, success: false, error: String(error) })
							}
						}

						// Attach files in parallel — each becomes an `attached` relationship
						// whose source_type is the object's real type ('bet' | 'task' |
						// 'insight'), matching create_objects and the web UI. Retrieval
						// goes by direction + targetType, but staying consistent keeps any
						// future source_type queries clean.
						//
						// We GET the existing rel first so a repeat attach is an
						// idempotent no-op (success + skipped) instead of failing the
						// (source_id, target_id, type) unique constraint.
						if (attach_file_ids?.length) {
							// One extra GET only when no PATCH ran — otherwise the type
							// already came back on the PATCH response.
							let sourceType = objectType
							if (sourceType === undefined) {
								try {
									const fetched = (await apiCall(
										config,
										'GET',
										`/api/objects/${id}`,
										undefined,
										wsOpts,
									)) as { type?: unknown }
									sourceType = typeof fetched?.type === 'string' ? fetched.type : undefined
								} catch {
									// Handled per-file below.
								}
							}

							const attachResults = await Promise.all(
								attach_file_ids.map(async (fileId) => {
									if (!sourceType) {
										return {
											type: 'file_attachment',
											id: `${id}->${fileId}`,
											success: false,
											error: 'Could not resolve object type for attachment',
										}
									}
									try {
										const params = new URLSearchParams()
										params.set('source_id', id)
										params.set('target_id', fileId)
										params.set('type', 'attached')
										const existing = (await apiCall(
											config,
											'GET',
											`/api/relationships?${params}`,
											undefined,
											wsOpts,
										)) as Array<{ id: string; targetType: string }>
										if (existing.some((r) => r.targetType === 'file')) {
											return {
												type: 'file_attachment',
												id: `${id}->${fileId}`,
												success: true,
												skipped: true,
											}
										}
										const result = await apiCall(
											config,
											'POST',
											'/api/relationships',
											{
												source_type: sourceType,
												source_id: id,
												target_type: 'file',
												target_id: fileId,
												type: 'attached',
											},
											wsOpts,
										)
										return {
											type: 'file_attachment',
											id: `${id}->${fileId}`,
											success: true,
											result,
										}
									} catch (error) {
										return {
											type: 'file_attachment',
											id: `${id}->${fileId}`,
											success: false,
											error: String(error),
										}
									}
								}),
							)
							out.push(...attachResults)
						}

						// Detach files: list relationships rooted at this object with
						// type='attached', match by target_id, then delete each.
						// Cheaper than asking the user to track relationship UUIDs.
						if (detach_file_ids?.length) {
							const detachResults = await Promise.all(
								detach_file_ids.map(async (fileId) => {
									try {
										const params = new URLSearchParams()
										params.set('source_id', id)
										params.set('target_id', fileId)
										params.set('type', 'attached')
										const rels = (await apiCall(
											config,
											'GET',
											`/api/relationships?${params}`,
											undefined,
											wsOpts,
										)) as Array<{ id: string; targetType: string }>
										const match = rels.find((r) => r.targetType === 'file')
										if (!match) {
											return {
												type: 'file_detachment',
												id: `${id}->${fileId}`,
												success: false,
												error: 'No attached relationship found between this object and file',
											}
										}
										const result = await apiCall(
											config,
											'DELETE',
											`/api/relationships/${match.id}`,
											undefined,
											wsOpts,
										)
										return {
											type: 'file_detachment',
											id: `${id}->${fileId}`,
											success: true,
											result,
										}
									} catch (error) {
										return {
											type: 'file_detachment',
											id: `${id}->${fileId}`,
											success: false,
											error: String(error),
										}
									}
								}),
							)
							out.push(...detachResults)
						}

						return out
					}),
				)
				for (const entry of objectResults) results.push(...entry)
			}

			// Create relationships in parallel
			if (args.edges?.length) {
				const edgeResults = await Promise.all(
					args.edges.map(async (edge) => {
						try {
							const result = await apiCall(
								config,
								'POST',
								'/api/relationships',
								{
									source_type: 'object',
									source_id: edge.source_id,
									target_type: 'object',
									target_id: edge.target_id,
									type: edge.type,
								},
								wsOpts,
							)
							return {
								type: 'relationship' as const,
								id: `${edge.source_id}->${edge.target_id}`,
								success: true,
								result,
							}
						} catch (error) {
							return {
								type: 'relationship' as const,
								id: `${edge.source_id}->${edge.target_id}`,
								success: false,
								error: String(error),
							}
						}
					}),
				)
				results.push(...edgeResults)
			}

			return {
				_meta: meta('update_objects', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_object',
		{
			description: tools.delete_object.description,
			inputSchema: tools.delete_object.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/objects/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('delete_object', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_objects',
		{
			description: tools.list_objects.description,
			inputSchema: tools.list_objects.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 50)
			const params = new URLSearchParams()
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.driver) params.set('driver', args.driver)
			if (args.updated_before) params.set('updated_before', args.updated_before)
			if (args.updated_after) params.set('updated_after', args.updated_after)
			if (args.sort) {
				params.set('sort', 'updatedAt')
				params.set('order', args.sort === 'updated_at_asc' ? 'asc' : 'desc')
			}
			const fetchCap = isResponseScopingEnabled() ? pagination.limit + 1 : pagination.limit
			params.set('limit', String(fetchCap))
			if (args.offset) params.set('offset', String(args.offset))
			if (isResponseScopingEnabled()) {
				params.set('snapshot_at', pagination.snapshotAt)
				if (!args.sort) {
					params.set('order', pagination.order)
					params.set('sort', 'createdAt')
				}
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			}
			const raw = (await apiCall(config, 'GET', `/api/objects?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as RawObject[]
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw)
			const result = trimmed as RawObject[]
			const offset = typeof args.offset === 'number' ? args.offset : 0
			const heroCard = await buildCollectionHeroCard(
				config,
				'list_objects',
				result,
				args.workspace_id,
				result.length,
				offset,
			)
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched = wsId
				? result.map((obj) =>
						addUrl(obj as unknown as Record<string, unknown>, config, wsId, {
							kind: 'object',
							id: obj.id,
						}),
					)
				: result
			const summaryRows: SummaryRow[] = result.map((obj, idx) => ({
				title: obj.title ?? `Untitled ${obj.type}`,
				url: pickUrl(enriched[idx]),
				meta: `${obj.type}${obj.status ? ` · ${obj.status}` : ''}`,
			}))
			return {
				_meta: uiMeta(
					'list_objects',
					config,
					args.workspace_id,
					pickCollectionResourceUri(heroCard),
				),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(enriched, summaryRows, 'No objects.'),
					},
				],
				structuredContent: {
					heroCard,
					objects: enriched,
					page: {
						limit: result.length,
						offset,
						returned: result.length,
						...(nextCursor ? { next_cursor: nextCursor } : {}),
					},
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
			}
		},
	)

	registerAppTool(
		server,
		'search_objects',
		{
			description: tools.search_objects.description,
			inputSchema: tools.search_objects.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 20)
			const params = new URLSearchParams()
			params.set('q', args.q)
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			const fetchCap = isResponseScopingEnabled() ? pagination.limit + 1 : pagination.limit
			params.set('limit', String(fetchCap))
			if (args.offset) params.set('offset', String(args.offset))
			if (isResponseScopingEnabled()) {
				params.set('snapshot_at', pagination.snapshotAt)
				params.set('order', pagination.order)
				params.set('sort', 'createdAt')
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			}
			const raw = (await apiCall(config, 'GET', `/api/objects/search?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as RawObject[]
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw)
			const result = trimmed as RawObject[]
			const offset = typeof args.offset === 'number' ? args.offset : 0
			const heroCard = await buildCollectionHeroCard(
				config,
				'search_objects',
				result,
				args.workspace_id,
				result.length,
				offset,
			)
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched = wsId
				? result.map((obj) =>
						addUrl(obj as unknown as Record<string, unknown>, config, wsId, {
							kind: 'object',
							id: obj.id,
						}),
					)
				: result
			const summaryRows: SummaryRow[] = result.map((obj, idx) => ({
				title: obj.title ?? `Untitled ${obj.type}`,
				url: pickUrl(enriched[idx]),
				meta: `${obj.type}${obj.status ? ` · ${obj.status}` : ''}`,
			}))
			return {
				_meta: uiMeta(
					'search_objects',
					config,
					args.workspace_id,
					pickCollectionResourceUri(heroCard),
				),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(enriched, summaryRows, 'No matches.'),
					},
				],
				structuredContent: {
					heroCard,
					objects: enriched,
					page: {
						limit: result.length,
						offset,
						returned: result.length,
						...(nextCursor ? { next_cursor: nextCursor } : {}),
					},
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
			}
		},
	)

	// ─── Relationships ────────────────────────────────────────
	registerAppTool(
		server,
		'list_relationships',
		{
			description: tools.list_relationships.description,
			inputSchema: tools.list_relationships.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 50)
			const params = new URLSearchParams()
			if (args.object_id) params.set('object_id', args.object_id)
			if (args.source_id) params.set('source_id', args.source_id)
			if (args.target_id) params.set('target_id', args.target_id)
			if (args.type) params.set('type', args.type)
			const fetchCap = isResponseScopingEnabled() ? pagination.limit + 1 : pagination.limit
			params.set('limit', String(fetchCap))
			if (typeof args.offset === 'number') params.set('offset', String(args.offset))
			if (isResponseScopingEnabled()) {
				params.set('snapshot_at', pagination.snapshotAt)
				params.set('order', pagination.order)
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			}
			const raw = (await apiCall(config, 'GET', `/api/relationships?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Array<{
				id: string
				sourceId: string
				targetId: string
				type: string
				createdAt?: string | null
				sourceTitle?: string | null
				targetTitle?: string | null
			}>
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw)
			const result = trimmed as typeof raw
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const baseUrl = config.webAppBaseUrl ? stripTrailingSlash(config.webAppBaseUrl) : undefined
			const summaryRows: SummaryRow[] = result.map((r) => {
				const sourceLabel = r.sourceTitle && r.sourceTitle.length > 0 ? r.sourceTitle : r.sourceId
				const targetLabel = r.targetTitle && r.targetTitle.length > 0 ? r.targetTitle : r.targetId
				return {
					title: `${sourceLabel} → ${targetLabel}`,
					url:
						baseUrl && wsId
							? buildWebAppHref(baseUrl, wsId, { kind: 'relationship', sourceId: r.sourceId })
							: undefined,
					meta: r.type,
				}
			})
			return {
				_meta: meta('list_relationships', config, (args as { workspace_id?: string }).workspace_id),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result, summaryRows, 'No relationships.'),
					},
				],
				...(nextCursor
					? {
							structuredContent: {
								relationships: result,
								next_cursor: nextCursor,
								page: {
									limit: result.length,
									offset: typeof args.offset === 'number' ? args.offset : 0,
									returned: result.length,
									next_cursor: nextCursor,
								},
							},
						}
					: {}),
			}
		},
	)

	registerAppTool(
		server,
		'delete_relationship',
		{
			description: tools.delete_relationship.description,
			inputSchema: tools.delete_relationship.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/relationships/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta(
					'delete_relationship',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Actors ───────────────────────────────────────────────
	registerAppTool(
		server,
		'create_actor',
		{
			description: tools.create_actor.description,
			inputSchema: tools.create_actor.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, role, ...createBody } = args
			const result = (await apiCall(config, 'POST', '/api/actors', createBody, {
				skipAuth: true,
				skipWorkspace: true,
			})) as { id: string; [key: string]: unknown }

			// If workspace_id provided, add the new actor as a member
			const targetWorkspace = workspace_id ?? config.defaultWorkspaceId
			if (targetWorkspace && !createBody.auto_create_workspace) {
				try {
					await apiCall(config, 'POST', `/api/workspaces/${targetWorkspace}/members`, {
						actor_id: result.id,
						role: role ?? 'member',
					})
					;(result as Record<string, unknown>).workspace_id = targetWorkspace
					;(result as Record<string, unknown>).role = role ?? 'member'
				} catch (error) {
					;(result as Record<string, unknown>).workspace_membership_error = String(error)
				}
			}

			const wsId = targetWorkspace ?? config.defaultWorkspaceId
			const withUrl =
				wsId && result.id
					? addUrl(result as unknown as Record<string, unknown>, config, wsId, {
							kind: 'actor',
							id: result.id,
						})
					: result
			return {
				_meta: meta('create_actor', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_actors',
		{
			description: tools.list_actors.description,
			inputSchema: tools.list_actors.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.heroCard, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 50)
			const offset = typeof args.offset === 'number' ? args.offset : 0
			// Under scoping we fetch `limit + 1` so the +1 sentinel drives the
			// next-cursor decision without a second query. The API caps `limit`
			// at 100 so the sentinel stays safely inside the ceiling.
			const fetchCap = isResponseScopingEnabled() ? pagination.limit + 1 : pagination.limit
			const params = new URLSearchParams({ limit: String(fetchCap), offset: String(offset) })
			if (isResponseScopingEnabled()) {
				params.set('snapshot_at', pagination.snapshotAt)
				params.set('order', pagination.order)
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			}
			const { data, response } = await apiCallWithResponse(
				config,
				'GET',
				`/api/actors?${params}`,
				undefined,
				args.workspace_id ? { workspaceId: args.workspace_id } : { skipWorkspace: true },
			)
			const rawRows = Array.isArray(data) ? (data as RawActor[]) : []
			// Trim the sentinel + seed next_cursor from the last-visible row's
			// (createdAt, id) tuple. Flag-off callers see the raw response.
			const { nextCursor, trimmed } = encodeNextCursor(
				pagination,
				rawRows as Array<{ id: string; createdAt?: string | null }>,
			)
			const rows = trimmed as RawActor[]
			const trimmedData = Array.isArray(data) ? (data as unknown[]).slice(0, rows.length) : data
			const heroObjects = rows.map((a) => buildActorHeroCardObject(a))
			const totalCount = parseTotalCountHeader(response, heroObjects.length)
			const heroCard: HeroCardPayload =
				heroObjects.length === 0
					? { kind: 'empty', tool: 'list_actors' }
					: heroObjects.length === 1 && totalCount === 1
						? { kind: 'single', tool: 'list_actors', object: heroObjects[0] }
						: {
								kind: 'list',
								tool: 'list_actors',
								objects: heroObjects.slice(0, HERO_CARD_UI_PAGE_SIZE),
								totalCount,
								page: {
									limit: Math.min(heroObjects.length, HERO_CARD_UI_PAGE_SIZE),
									offset,
									hasMore:
										offset + Math.min(heroObjects.length, HERO_CARD_UI_PAGE_SIZE) < totalCount,
								},
							}
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched =
				wsId && Array.isArray(trimmedData)
					? (trimmedData as Array<Record<string, unknown>>).map((a) =>
							addUrl(a, config, wsId, { kind: 'actor', id: a.id as string }),
						)
					: trimmedData
			const enrichedRows: Array<Record<string, unknown>> = Array.isArray(enriched)
				? (enriched as Array<Record<string, unknown>>)
				: []
			const summaryRows: SummaryRow[] = rows.map((actor, idx) => {
				const kind = actor.type ?? 'actor'
				const metaParts = [kind]
				if (actor.role) metaParts.push(actor.role)
				return {
					title: actor.name ?? `${kind} ${actor.id.slice(0, 8)}`,
					url: pickUrl(enrichedRows[idx]),
					meta: metaParts.join(' · '),
				}
			})
			return {
				_meta: uiMeta(
					'list_actors',
					config,
					args.workspace_id,
					pickCollectionResourceUri(heroCard),
				),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(enriched, summaryRows, 'No actors.'),
					},
				],
				structuredContent: {
					heroCard,
					...(nextCursor
						? {
								next_cursor: nextCursor,
								page: {
									limit: rows.length,
									offset,
									returned: rows.length,
									next_cursor: nextCursor,
								},
							}
						: {}),
				},
			}
		},
	)

	registerAppTool(
		server,
		'get_actor',
		{
			description: tools.get_actor.description,
			inputSchema: tools.get_actor.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.heroCard, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', `/api/actors/${args.id}`, undefined, {
				skipWorkspace: true,
			})) as RawActor
			const heroCard: HeroCardPayload = {
				kind: 'single',
				tool: 'get_actor',
				object: buildActorHeroCardObject(result, true),
			}
			const workspaceId = (args as { workspace_id?: string }).workspace_id
			const wsId = workspaceId ?? config.defaultWorkspaceId
			const withUrl = wsId
				? addUrl(result as unknown as Record<string, unknown>, config, wsId, {
						kind: 'actor',
						id: result.id,
					})
				: result
			return {
				_meta: uiMeta('get_actor', config, workspaceId, UI_RESOURCES.heroCard),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
				structuredContent: { heroCard },
			}
		},
	)

	registerAppTool(
		server,
		'update_actor',
		{
			description: tools.update_actor.description,
			inputSchema: tools.update_actor.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const { id, attach_skill_ids, detach_skill_ids, ...body } = args
			const attachIds = attach_skill_ids ?? []
			const detachIds = detach_skill_ids ?? []
			const hasSkillOps = attachIds.length > 0 || detachIds.length > 0

			const overlapping = attachIds.filter((sid) => detachIds.includes(sid))
			if (overlapping.length > 0) {
				throw new Error(
					`Skill IDs appear in both attach_skill_ids and detach_skill_ids: ${overlapping.join(', ')}`,
				)
			}

			// Run actor PATCH first so a failure here throws before any skill ops fire.
			const actor = await apiCall(config, 'PATCH', `/api/actors/${id}`, body, {
				skipWorkspace: true,
			})

			if (!hasSkillOps) {
				const wsId = (args as { workspace_id?: string }).workspace_id ?? config.defaultWorkspaceId
				const actorId = (actor as { id?: string }).id
				const withUrl =
					wsId && actorId
						? addUrl(actor as Record<string, unknown>, config, wsId, { kind: 'actor', id: actorId })
						: actor
				return {
					_meta: meta('update_actor', config, (args as { workspace_id?: string }).workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
				}
			}

			// Skill ops run concurrently but with allSettled so a single failure doesn't
			// discard the results of operations that already succeeded.
			const skillSettled = await Promise.allSettled([
				...attachIds.map((skillId) =>
					apiCall(
						config,
						'POST',
						`/api/actors/${id}/workspace-skills`,
						{ workspaceSkillId: skillId },
						{ skipWorkspace: true },
					),
				),
				...detachIds.map((skillId) =>
					apiCall(config, 'DELETE', `/api/actors/${id}/workspace-skills/${skillId}`, undefined, {
						skipWorkspace: true,
					}),
				),
			])

			const toErrorEntry = (reason: unknown, skillId: string) => ({
				skill_id: skillId,
				error: reason instanceof Error ? reason.message : String(reason),
			})
			const toAttachEntry = (s: PromiseSettledResult<unknown>, skillId: string) =>
				s.status === 'fulfilled' ? s.value : toErrorEntry(s.reason, skillId)
			const toDetachEntry = (s: PromiseSettledResult<unknown>, skillId: string) =>
				s.status === 'fulfilled'
					? { skill_id: skillId, deleted: true }
					: toErrorEntry(s.reason, skillId)

			const attachCount = attachIds.length
			const wsId2 = (args as { workspace_id?: string }).workspace_id ?? config.defaultWorkspaceId
			const actorId = (actor as { id?: string }).id
			const actorWithUrl =
				wsId2 && actorId
					? addUrl(actor as Record<string, unknown>, config, wsId2, { kind: 'actor', id: actorId })
					: actor
			const output: Record<string, unknown> = { actor: actorWithUrl }
			if (attachIds.length) {
				output.attached_skills = skillSettled
					.slice(0, attachCount)
					// biome-ignore lint/style/noNonNullAssertion: slice bounds match attachIds
					.map((s, i) => toAttachEntry(s, attachIds[i]!))
			}
			if (detachIds.length) {
				output.detached_skills = skillSettled
					.slice(attachCount)
					// biome-ignore lint/style/noNonNullAssertion: slice bounds match detachIds
					.map((s, i) => toDetachEntry(s, detachIds[i]!))
			}
			if (skillSettled.some((s) => s.status === 'rejected')) {
				output.partial_failure = true
			}

			return {
				_meta: meta('update_actor', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'regenerate_api_key',
		{
			description: tools.regenerate_api_key.description,
			inputSchema: tools.regenerate_api_key.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/actors/${args.id}/api-keys`, undefined, {
				skipWorkspace: true,
			})
			return {
				_meta: meta('regenerate_api_key', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Workspaces ───────────────────────────────────────────
	registerAppTool(
		server,
		'create_workspace',
		{
			description: tools.create_workspace.description,
			inputSchema: tools.create_workspace.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'POST', '/api/workspaces', args, {
				skipWorkspace: true,
			})
			return {
				_meta: meta('create_workspace', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'update_workspace',
		{
			description: tools.update_workspace.description,
			inputSchema: tools.update_workspace.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const { id, ...body } = args
			const result = await apiCall(config, 'PATCH', `/api/workspaces/${id}`, body, {
				skipWorkspace: true,
			})
			return {
				_meta: meta('update_workspace', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_workspaces',
		{
			description: tools.list_workspaces.description,
			inputSchema: tools.list_workspaces.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.heroCard, csp: CSP } },
		},
		async () => {
			const result = await apiCall(config, 'GET', '/api/workspaces', undefined, {
				skipWorkspace: true,
			})
			const rows = Array.isArray(result) ? (result as RawWorkspace[]) : []
			const heroObjects = rows.map(buildWorkspaceHeroCardObject)
			const webContextWorkspaceId = config.defaultWorkspaceId ?? rows[0]?.id
			const heroCard: HeroCardPayload =
				heroObjects.length === 0
					? { kind: 'empty', tool: 'list_workspaces' }
					: heroObjects.length === 1
						? { kind: 'single', tool: 'list_workspaces', object: heroObjects[0] }
						: {
								kind: 'list',
								tool: 'list_workspaces',
								objects: heroObjects.slice(0, HERO_CARD_UI_PAGE_SIZE),
								totalCount: heroObjects.length,
								page: {
									limit: Math.min(heroObjects.length, HERO_CARD_UI_PAGE_SIZE),
									offset: 0,
									hasMore: heroObjects.length > HERO_CARD_UI_PAGE_SIZE,
								},
							}
			return {
				_meta: uiMeta('list_workspaces', config, webContextWorkspaceId, UI_RESOURCES.heroCard),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				structuredContent: { heroCard },
			}
		},
	)

	registerAppTool(
		server,
		'get_workspace_schema',
		{
			description: tools.get_workspace_schema.description,
			inputSchema: tools.get_workspace_schema.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
				skipWorkspace: true,
			})) as Array<{
				id: string
				name: string
				settings: Record<string, unknown>
			}>
			const effectiveWsId = args.workspace_id ?? config.defaultWorkspaceId
			const workspace =
				(effectiveWsId ? workspaces.find((w) => w.id === effectiveWsId) : workspaces[0]) ??
				workspaces[0]
			if (!workspace) {
				throw new Error('No workspace found')
			}

			const settings = workspace.settings ?? {}
			const statuses = (settings.statuses ?? {}) as Record<string, string[]>
			const fieldDefinitions = (settings.field_definitions ?? {}) as Record<
				string,
				Array<{ name: string; type: string; required: boolean; values?: string[] }>
			>
			const displayNames = (settings.display_names ?? {}) as Record<string, string>
			const relationshipTypes = (settings.relationship_types ?? []) as string[]
			const heroCardOverrides = (settings.hero_card ?? {}) as Record<string, HeroCardTypeAnnotation>
			// Workspace settings override built-in defaults so a workspace can rewire
			// the customer variant (or annotate a new type) without a code change.
			const heroCardAnnotations: Record<string, HeroCardTypeAnnotation> = {
				...HERO_CARD_TYPE_DEFAULTS,
				...heroCardOverrides,
			}
			const typeFilter = args.type

			const schema: Record<string, unknown> = {
				workspace_id: workspace.id,
				workspace_name: workspace.name,
				relationship_types: relationshipTypes,
			}

			// Dynamic types: use all types defined in workspace statuses (from enabled extensions)
			const allTypes = Object.keys(statuses)
			const types = typeFilter ? [typeFilter] : allTypes
			const typeSchemas: Record<string, unknown> = {}

			for (const t of types) {
				const typeSchema: Record<string, unknown> = {
					display_name: displayNames[t] ?? t,
					statuses: statuses[t] ?? [],
					fields: fieldDefinitions[t] ?? [],
				}
				const hc = heroCardAnnotations[t]
				if (hc) typeSchema.hero_card = hc
				typeSchemas[t] = typeSchema
			}

			schema.types = typeSchemas

			return {
				_meta: meta(
					'get_workspace_schema',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(schema, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'add_workspace_member',
		{
			description: tools.add_workspace_member.description,
			inputSchema: tools.add_workspace_member.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(
				config,
				'POST',
				`/api/workspaces/${args.workspace_id}/members`,
				{ actor_id: args.actor_id, role: args.role },
				{ skipWorkspace: true },
			)
			return {
				_meta: meta(
					'add_workspace_member',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Workspace Schema Editing (W1) ───────────────────────
	// Mirrors the web schema editor at
	// apps/web/src/routes/_authed/$workspaceId/settings/objects/$propertyName.tsx —
	// each tool does read-modify-write on settings.field_definitions because the
	// workspace PATCH endpoint shallow-merges `settings`. Auth flows through the
	// same Bearer token used by every other tool, so changes are attributed to
	// the calling end-user (per F4 calling-user auth model).
	//
	// Concurrency: workspace PATCH only shallow-merges `settings`, so two
	// interleaved RMWs on `field_definitions` would lose updates. We mitigate
	// this with three layers:
	//   1) Per-workspace in-process mutex (`withWorkspaceLock`) so back-to-back
	//      MCP tool calls in this process never race.
	//   2) Idempotency-Key on the PATCH so the host's retries don't double-apply.
	//   3) Re-read after PATCH and compare; on drift, retry up to 3 times. This
	//      catches cross-process races (a different MCP server or the web UI
	//      patching the same workspace concurrently).
	type FieldDef = {
		name: string
		type: 'text' | 'number' | 'date' | 'enum' | 'boolean'
		required?: boolean
		values?: string[]
	}

	const MAX_RMW_ATTEMPTS = 3

	function fieldsEqual(a: FieldDef[], b: FieldDef[]): boolean {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i++) {
			const x = a[i] as FieldDef
			const y = b[i] as FieldDef
			if (x.name !== y.name) return false
			if (x.type !== y.type) return false
			if ((x.required ?? false) !== (y.required ?? false)) return false
			const xv = x.values ?? []
			const yv = y.values ?? []
			if (xv.length !== yv.length) return false
			for (let j = 0; j < xv.length; j++) if (xv[j] !== yv[j]) return false
		}
		return true
	}

	function fieldDefMapsEqual(
		a: Record<string, FieldDef[]>,
		b: Record<string, FieldDef[]>,
	): boolean {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)])
		for (const k of keys) {
			if (!fieldsEqual(a[k] ?? [], b[k] ?? [])) return false
		}
		return true
	}

	async function patchFieldDefinitions(
		args: { workspace_id?: string; type: string },
		transform: (current: FieldDef[]) => FieldDef[],
	): Promise<{ wsId: string; updatedFields: FieldDef[] }> {
		const wsId = args.workspace_id ?? config.defaultWorkspaceId
		if (!wsId) throw new Error(`No workspace specified. ${workspaceSetupHint(config)}`)
		return withWorkspaceLock(wsId, async () => {
			let lastErr: Error | null = null
			for (let attempt = 0; attempt < MAX_RMW_ATTEMPTS; attempt++) {
				const workspace = await getWorkspace(config, wsId)
				const baseline = {
					...((workspace.settings.field_definitions ?? {}) as Record<string, FieldDef[]>),
				}
				const fieldDefs = { ...baseline }
				const current = (fieldDefs[args.type] ?? []) as FieldDef[]
				const updated = transform(current)
				fieldDefs[args.type] = updated
				await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${wsId}`,
					{ settings: { field_definitions: fieldDefs } },
					{ workspaceId: wsId, idempotencyKey: `mcp-schema-${wsId}-${randomUUID()}` },
				)
				const verify = await getWorkspace(config, wsId)
				const verifyAll = (verify.settings.field_definitions ?? {}) as Record<string, FieldDef[]>
				if (fieldDefMapsEqual(verifyAll, fieldDefs)) {
					return { wsId, updatedFields: updated }
				}
				lastErr = new Error(
					`Concurrent edit detected on workspace "${wsId}" (attempt ${attempt + 1}/${MAX_RMW_ATTEMPTS}). Another writer modified field_definitions between read and verify; retrying.`,
				)
			}
			throw (
				lastErr ??
				new Error(
					`Failed to apply schema change to workspace "${wsId}" type "${args.type}" after ${MAX_RMW_ATTEMPTS} attempts due to concurrent edits.`,
				)
			)
		})
	}

	function ensureEnumField(field: FieldDef): asserts field is FieldDef & { values: string[] } {
		if (field.type !== 'enum') {
			throw new Error(`Field "${field.name}" is type "${field.type}", not "enum"`)
		}
		if (!Array.isArray(field.values)) {
			throw new Error(
				`Field "${field.name}" is type "enum" but has no values list. Repair via update_workspace_field with values: [...] before adding or removing values.`,
			)
		}
	}

	registerAppTool(
		server,
		'create_workspace_field',
		{
			description: tools.create_workspace_field.description,
			inputSchema: tools.create_workspace_field.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.schema, csp: CSP } },
		},
		async (args) => {
			if (args.field_type === 'enum' && (!args.values || args.values.length === 0)) {
				throw new Error('Enum fields require at least one value in `values`.')
			}
			const { wsId, updatedFields } = await patchFieldDefinitions(args, (current) => {
				if (current.some((f) => f.name === args.name)) {
					throw new Error(
						`Field "${args.name}" already exists on type "${args.type}". Use update_workspace_field to modify it.`,
					)
				}
				const next: FieldDef = {
					name: args.name,
					type: args.field_type,
					...(args.required ? { required: true } : {}),
					...(args.field_type === 'enum' && args.values ? { values: args.values } : {}),
				}
				return [...current, next]
			})
			const created = updatedFields.find((f) => f.name === args.name)
			return {
				_meta: meta('create_workspace_field', config, wsId),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ workspace_id: wsId, type: args.type, field: created }, null, 2),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'update_workspace_field',
		{
			description: tools.update_workspace_field.description,
			inputSchema: tools.update_workspace_field.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.schema, csp: CSP } },
		},
		async (args) => {
			const { wsId, updatedFields } = await patchFieldDefinitions(args, (current) => {
				const idx = current.findIndex((f) => f.name === args.name)
				if (idx === -1) {
					throw new Error(`Field "${args.name}" not found on type "${args.type}".`)
				}
				const existing = current[idx] as FieldDef
				const nextName = args.new_name ?? existing.name
				if (
					nextName !== existing.name &&
					current.some((f, i) => i !== idx && f.name === nextName)
				) {
					throw new Error(
						`Field "${nextName}" already exists on type "${args.type}". Choose a different name.`,
					)
				}
				const nextType = args.field_type ?? existing.type
				const nextRequired = args.required ?? existing.required ?? false
				let nextValues: string[] | undefined
				if (nextType === 'enum') {
					nextValues = args.values ?? existing.values ?? []
					if (nextValues.length === 0) {
						throw new Error('Enum fields require at least one value in `values`.')
					}
				}
				const next: FieldDef = {
					name: nextName,
					type: nextType,
					...(nextRequired ? { required: true } : {}),
					...(nextType === 'enum' && nextValues ? { values: nextValues } : {}),
				}
				const copy = [...current]
				copy[idx] = next
				return copy
			})
			const renamed = args.new_name ?? args.name
			const updated = updatedFields.find((f) => f.name === renamed)
			return {
				_meta: meta('update_workspace_field', config, wsId),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ workspace_id: wsId, type: args.type, field: updated }, null, 2),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'delete_workspace_field',
		{
			description: tools.delete_workspace_field.description,
			inputSchema: tools.delete_workspace_field.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.schema, csp: CSP } },
		},
		async (args) => {
			const { wsId } = await patchFieldDefinitions(args, (current) =>
				current.filter((f) => f.name !== args.name),
			)
			return {
				_meta: meta('delete_workspace_field', config, wsId),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{ workspace_id: wsId, type: args.type, deleted: args.name, success: true },
							null,
							2,
						),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'add_workspace_enum_value',
		{
			description: tools.add_workspace_enum_value.description,
			inputSchema: tools.add_workspace_enum_value.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.schema, csp: CSP } },
		},
		async (args) => {
			const { wsId, updatedFields } = await patchFieldDefinitions(args, (current) => {
				const idx = current.findIndex((f) => f.name === args.name)
				if (idx === -1) {
					throw new Error(`Field "${args.name}" not found on type "${args.type}".`)
				}
				const field = current[idx] as FieldDef
				ensureEnumField(field)
				if (field.values.includes(args.value)) return current
				const copy = [...current]
				copy[idx] = { ...field, values: [...field.values, args.value] }
				return copy
			})
			const updated = updatedFields.find((f) => f.name === args.name)
			return {
				_meta: meta('add_workspace_enum_value', config, wsId),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ workspace_id: wsId, type: args.type, field: updated }, null, 2),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'remove_workspace_enum_value',
		{
			description: tools.remove_workspace_enum_value.description,
			inputSchema: tools.remove_workspace_enum_value.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.schema, csp: CSP } },
		},
		async (args) => {
			const { wsId, updatedFields } = await patchFieldDefinitions(args, (current) => {
				const idx = current.findIndex((f) => f.name === args.name)
				if (idx === -1) {
					throw new Error(`Field "${args.name}" not found on type "${args.type}".`)
				}
				const field = current[idx] as FieldDef
				ensureEnumField(field)
				if (!field.values.includes(args.value)) return current
				const copy = [...current]
				copy[idx] = { ...field, values: field.values.filter((v) => v !== args.value) }
				return copy
			})
			const updated = updatedFields.find((f) => f.name === args.name)
			return {
				_meta: meta('remove_workspace_enum_value', config, wsId),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ workspace_id: wsId, type: args.type, field: updated }, null, 2),
					},
				],
			}
		},
	)

	// ─── Workspace Skills ────────────────────────────────────
	// Thin HTTP wrappers around /api/workspaces/:workspaceId/skills — the shared
	// skill library. These are workspace-scoped, attachable to any agent in the
	// workspace. The backend route enforces membership; we resolve the effective
	// workspace ID from the arg or DEFAULT_WORKSPACE_ID before building the path.
	const resolveWorkspaceId = (workspaceId?: string): string => {
		const wsId = workspaceId ?? config.defaultWorkspaceId
		if (!wsId) throw new Error(`No workspace specified. ${workspaceSetupHint(config)}`)
		return wsId
	}

	registerAppTool(
		server,
		'list_workspace_skills',
		{
			description: tools.list_workspace_skills.description,
			inputSchema: tools.list_workspace_skills.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 50)
			const scoped = isResponseScopingEnabled()
			const params = new URLSearchParams()
			if (scoped) {
				params.set('limit', String(pagination.limit + 1))
				params.set('snapshot_at', pagination.snapshotAt)
				params.set('order', pagination.order)
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			} else {
				if (typeof args.limit === 'number') params.set('limit', String(args.limit))
				if (typeof args.offset === 'number') params.set('offset', String(args.offset))
			}
			const qs = params.toString()
			const raw = (await apiCall(
				config,
				'GET',
				`/api/workspaces/${wsId}/skills${qs ? `?${qs}` : ''}`,
				undefined,
				{ workspaceId: wsId },
			)) as Array<{
				id: string
				name: string
				description?: string | null
				isValid?: boolean
				createdAt?: string | null
			}>
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw)
			const result = trimmed as typeof raw
			const baseUrl = config.webAppBaseUrl ? stripTrailingSlash(config.webAppBaseUrl) : undefined
			const summaryRows: SummaryRow[] = result.map((skill) => {
				const metaParts: string[] = []
				if (skill.isValid === false) metaParts.push('invalid')
				const description = skill.description?.split(/\r?\n/)[0]?.trim()
				if (description) metaParts.push(makePreview(description, 80))
				return {
					title: skill.name,
					url: baseUrl
						? buildWebAppHref(baseUrl, wsId, { kind: 'skill', name: skill.name })
						: undefined,
					meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
				}
			})
			return {
				_meta: meta(
					'list_workspace_skills',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result, summaryRows, 'No skills.'),
					},
				],
				...(nextCursor
					? {
							structuredContent: {
								skills: result,
								next_cursor: nextCursor,
								page: {
									limit: result.length,
									offset: typeof args.offset === 'number' ? args.offset : 0,
									returned: result.length,
									next_cursor: nextCursor,
								},
							},
						}
					: {}),
			}
		},
	)

	registerAppTool(
		server,
		'get_workspace_skill',
		{
			description: tools.get_workspace_skill.description,
			inputSchema: tools.get_workspace_skill.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(
				config,
				'GET',
				`/api/workspaces/${wsId}/skills/${encodeURIComponent(args.name)}`,
				undefined,
				{ workspaceId: wsId },
			)
			return {
				_meta: meta(
					'get_workspace_skill',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'create_workspace_skill',
		{
			description: tools.create_workspace_skill.description,
			inputSchema: tools.create_workspace_skill.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(
				config,
				'POST',
				`/api/workspaces/${wsId}/skills`,
				{ name: args.name, content: args.content },
				{ workspaceId: wsId },
			)
			return {
				_meta: meta(
					'create_workspace_skill',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'update_workspace_skill',
		{
			description: tools.update_workspace_skill.description,
			inputSchema: tools.update_workspace_skill.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(
				config,
				'PUT',
				`/api/workspaces/${wsId}/skills/${encodeURIComponent(args.name)}`,
				{ content: args.content },
				{ workspaceId: wsId },
			)
			return {
				_meta: meta(
					'update_workspace_skill',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_workspace_skill',
		{
			description: tools.delete_workspace_skill.description,
			inputSchema: tools.delete_workspace_skill.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(
				config,
				'DELETE',
				`/api/workspaces/${wsId}/skills/${encodeURIComponent(args.name)}`,
				undefined,
				{ workspaceId: wsId },
			)
			return {
				_meta: meta(
					'delete_workspace_skill',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Files ───────────────────────────────────────────────
	registerAppTool(
		server,
		'create_file',
		{
			description: tools.create_file.description,
			inputSchema: tools.create_file.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(
				config,
				'POST',
				'/api/files',
				{
					name: args.name,
					description: args.description,
					mime_type: args.mime_type,
					content: args.content,
					...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
				},
				{ workspaceId: wsId },
			)
			return {
				_meta: meta('create_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_files',
		{
			description: tools.list_files.description,
			inputSchema: tools.list_files.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 50)
			const scoped = isResponseScopingEnabled()
			const params = new URLSearchParams()
			if (args.q) params.set('q', args.q)
			if (scoped) {
				params.set('limit', String(pagination.limit + 1))
				if (args.offset !== undefined) params.set('offset', String(args.offset))
				params.set('snapshot_at', pagination.snapshotAt)
				params.set('order', pagination.order)
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			} else {
				if (args.limit !== undefined) params.set('limit', String(args.limit))
				if (args.offset !== undefined) params.set('offset', String(args.offset))
			}
			const qs = params.toString()
			const raw = (await apiCall(config, 'GET', `/api/files${qs ? `?${qs}` : ''}`, undefined, {
				workspaceId: wsId,
			})) as Array<{
				id: string
				name: string
				mimeType?: string | null
				sizeBytes?: number | null
				createdAt?: string | null
			}>
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw)
			const result = trimmed as typeof raw
			const baseUrl = config.webAppBaseUrl ? stripTrailingSlash(config.webAppBaseUrl) : undefined
			const summaryRows: SummaryRow[] = result.map((file) => {
				const metaParts: string[] = []
				if (file.mimeType) metaParts.push(file.mimeType)
				if (typeof file.sizeBytes === 'number') metaParts.push(`${file.sizeBytes}B`)
				return {
					title: file.name,
					url: baseUrl ? buildWebAppHref(baseUrl, wsId, { kind: 'file', id: file.id }) : undefined,
					meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
				}
			})
			return {
				_meta: meta('list_files', config, (args as { workspace_id?: string }).workspace_id),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result, summaryRows, 'No files.'),
					},
				],
				...(nextCursor
					? {
							structuredContent: {
								files: result,
								next_cursor: nextCursor,
								page: {
									limit: result.length,
									offset: typeof args.offset === 'number' ? args.offset : 0,
									returned: result.length,
									next_cursor: nextCursor,
								},
							},
						}
					: {}),
			}
		},
	)

	registerAppTool(
		server,
		'get_file',
		{
			description: tools.get_file.description,
			inputSchema: tools.get_file.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(config, 'GET', `/api/files/${args.id}`, undefined, {
				workspaceId: wsId,
			})
			return {
				_meta: meta('get_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'update_file',
		{
			description: tools.update_file.description,
			inputSchema: tools.update_file.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const body: Record<string, unknown> = {}
			if (args.name !== undefined) body.name = args.name
			if (args.description !== undefined) body.description = args.description
			if (args.mime_type !== undefined) body.mime_type = args.mime_type
			if (args.content !== undefined) body.content = args.content
			if (args.encoding !== undefined) body.encoding = args.encoding
			const result = await apiCall(config, 'PATCH', `/api/files/${args.id}`, body, {
				workspaceId: wsId,
			})
			return {
				_meta: meta('update_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_file',
		{
			description: tools.delete_file.description,
			inputSchema: tools.delete_file.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = resolveWorkspaceId(args.workspace_id)
			const result = await apiCall(config, 'DELETE', `/api/files/${args.id}`, undefined, {
				workspaceId: wsId,
			})
			return {
				_meta: meta('delete_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Events ───────────────────────────────────────────────
	registerAppTool(
		server,
		'get_events',
		{
			description: tools.get_events.description,
			inputSchema: tools.get_events.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.id) params.set('id', String(args.id))
			if (args.entity_type) params.set('entity_type', args.entity_type)
			if (args.action) params.set('action', args.action)
			if (args.limit) params.set('limit', String(args.limit))
			const result = await apiCall(config, 'GET', `/api/events/history?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('get_events', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Comments ─────────────────────────────────────────────
	registerAppTool(
		server,
		'get_comments',
		{
			description: tools.get_comments.description,
			inputSchema: tools.get_comments.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			params.set('entity_type', 'object')
			params.set('entity_id', args.entity_id)
			params.set('action', 'commented')
			params.set('limit', String(args.limit))
			params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/events/history?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('get_comments', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'create_comment',
		{
			description: tools.create_comment.description,
			inputSchema: tools.create_comment.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/events', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta('create_comment', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Triggers ─────────────────────────────────────────────
	registerAppTool(
		server,
		'create_trigger',
		{
			description: tools.create_trigger.description,
			inputSchema: tools.create_trigger.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/triggers', body, {
				workspaceId: workspace_id,
			})
			const wsId =
				(result as { workspaceId?: string }).workspaceId ??
				workspace_id ??
				config.defaultWorkspaceId
			const triggerId = (result as { id?: string }).id
			const withUrl =
				wsId && triggerId
					? addUrl(result as Record<string, unknown>, config, wsId, {
							kind: 'trigger',
							id: triggerId,
						})
					: result
			return {
				_meta: meta('create_trigger', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_triggers',
		{
			description: tools.list_triggers.description,
			inputSchema: tools.list_triggers.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.heroCard, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor }, 50)
			const offset = typeof args.offset === 'number' ? args.offset : 0
			const fetchCap = isResponseScopingEnabled() ? pagination.limit + 1 : pagination.limit
			const params = new URLSearchParams({ limit: String(fetchCap), offset: String(offset) })
			if (isResponseScopingEnabled()) {
				params.set('snapshot_at', pagination.snapshotAt)
				params.set('order', pagination.order)
				if (pagination.cursor) {
					params.set('cursor_created_at', pagination.cursor.k.sortValue)
					params.set('cursor_id', pagination.cursor.k.id)
				}
			}
			const { data, response } = await apiCallWithResponse(
				config,
				'GET',
				`/api/triggers?${params}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)
			const rawRows = Array.isArray(data) ? (data as RawTrigger[]) : []
			const { nextCursor, trimmed } = encodeNextCursor(
				pagination,
				rawRows as Array<{ id: string; createdAt?: string | null }>,
			)
			const rows = trimmed as RawTrigger[]
			const trimmedData = Array.isArray(data) ? (data as unknown[]).slice(0, rows.length) : data
			const ownerIds = rows
				.map((t) => t.targetActorId)
				.filter((v): v is string => typeof v === 'string')
			const actors = await resolveActors(config, ownerIds, args.workspace_id)
			const heroObjects = rows.map((t) =>
				buildTriggerHeroCardObject(
					t,
					t.targetActorId ? (actors.get(t.targetActorId) ?? null) : null,
				),
			)
			const totalCount = parseTotalCountHeader(response, heroObjects.length)
			const heroCard: HeroCardPayload =
				heroObjects.length === 0
					? { kind: 'empty', tool: 'list_triggers' }
					: heroObjects.length === 1 && totalCount === 1
						? { kind: 'single', tool: 'list_triggers', object: heroObjects[0] }
						: {
								kind: 'list',
								tool: 'list_triggers',
								objects: heroObjects.slice(0, HERO_CARD_UI_PAGE_SIZE),
								totalCount,
								page: {
									limit: Math.min(heroObjects.length, HERO_CARD_UI_PAGE_SIZE),
									offset,
									hasMore:
										offset + Math.min(heroObjects.length, HERO_CARD_UI_PAGE_SIZE) < totalCount,
								},
							}
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched =
				wsId && Array.isArray(trimmedData)
					? (trimmedData as Array<Record<string, unknown>>).map((t) =>
							addUrl(t, config, (t.workspaceId as string | undefined) ?? wsId, {
								kind: 'trigger',
								id: t.id as string,
							}),
						)
					: trimmedData
			const enrichedRows: Array<Record<string, unknown>> = Array.isArray(enriched)
				? (enriched as Array<Record<string, unknown>>)
				: []
			const summaryRows: SummaryRow[] = rows.map((trigger, idx) => {
				const enabledLabel = trigger.enabled ? 'enabled' : 'disabled'
				return {
					title: trigger.name || `Trigger ${trigger.id.slice(0, 8)}`,
					url: pickUrl(enrichedRows[idx]),
					meta: `${trigger.type} · ${enabledLabel}`,
				}
			})
			return {
				_meta: uiMeta(
					'list_triggers',
					config,
					args.workspace_id,
					pickCollectionResourceUri(heroCard),
				),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(enriched, summaryRows, 'No triggers.'),
					},
				],
				structuredContent: {
					heroCard,
					...(nextCursor
						? {
								next_cursor: nextCursor,
								page: {
									limit: rows.length,
									offset,
									returned: rows.length,
									next_cursor: nextCursor,
								},
							}
						: {}),
				},
			}
		},
	)

	registerAppTool(
		server,
		'update_trigger',
		{
			description: tools.update_trigger.description,
			inputSchema: tools.update_trigger.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const { id, workspace_id, ...body } = args
			const result = await apiCall(config, 'PATCH', `/api/triggers/${id}`, body, {
				workspaceId: workspace_id,
			})
			const wsId =
				(result as { workspaceId?: string }).workspaceId ??
				workspace_id ??
				config.defaultWorkspaceId
			const withUrl = wsId
				? addUrl(result as Record<string, unknown>, config, wsId, { kind: 'trigger', id })
				: result
			return {
				_meta: meta('update_trigger', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_trigger',
		{
			description: tools.delete_trigger.description,
			inputSchema: tools.delete_trigger.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/triggers/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('delete_trigger', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Notifications ────────────────────────────────────────
	// Temporarily hidden from the MCP surface while we rethink the notification
	// product flow. Tool definitions remain in `tools.ts` so re-enabling is a
	// matter of uncommenting these `registerAppTool` calls.
	/*
	registerAppTool(
		server,
		'create_notification',
		{
			description: tools.create_notification.description,
			inputSchema: tools.create_notification.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args

			// Auto-parse metadata.actions if LLM passed it as a JSON string instead of an array
			if (body.metadata?.actions != null) {
				if (typeof body.metadata.actions === 'string') {
					try {
						const parsed = JSON.parse(body.metadata.actions)
						if (Array.isArray(parsed)) {
							body.metadata.actions = parsed
						} else {
							throw new Error('metadata.actions must be an array')
						}
					} catch (e) {
						if (e instanceof SyntaxError) {
							throw new Error('metadata.actions must be a valid JSON array or native array')
						}
						throw e
					}
				} else if (!Array.isArray(body.metadata.actions)) {
					throw new Error('metadata.actions must be an array')
				}
			}

			const result = await apiCall(config, 'POST', '/api/notifications', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta(
					'create_notification',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_notifications',
		{
			description: tools.list_notifications.description,
			inputSchema: tools.list_notifications.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.status) params.set('status', args.status)
			if (args.type) params.set('type', args.type)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/notifications?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('list_notifications', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_notification',
		{
			description: tools.get_notification.description,
			inputSchema: tools.get_notification.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'GET', `/api/notifications/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('get_notification', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'update_notification',
		{
			description: tools.update_notification.description,
			inputSchema: tools.update_notification.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { id, workspace_id, ...body } = args
			const result = await apiCall(config, 'PATCH', `/api/notifications/${id}`, body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta(
					'update_notification',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_notification',
		{
			description: tools.delete_notification.description,
			inputSchema: tools.delete_notification.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/notifications/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta(
					'delete_notification',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)
	*/

	// ─── Subscriptions ────────────────────────────────────────
	registerAppTool(
		server,
		'subscribe',
		{
			description: tools.subscribe.description,
			inputSchema: tools.subscribe.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/subscriptions', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta('subscribe', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'unsubscribe',
		{
			description: tools.unsubscribe.description,
			inputSchema: tools.unsubscribe.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'DELETE', '/api/subscriptions', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta('unsubscribe', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_subscribers',
		{
			description: tools.list_subscribers.description,
			inputSchema: tools.list_subscribers.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams({
				entity_type: args.entity_type,
				entity_id: args.entity_id,
			})
			const result = await apiCall(
				config,
				'GET',
				`/api/subscriptions/subscribers?${params}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta('list_subscribers', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'mark_read',
		{
			description: tools.mark_read.description,
			inputSchema: tools.mark_read.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/subscriptions/read', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta('mark_read', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_unread',
		{
			description: tools.list_unread.description,
			inputSchema: tools.list_unread.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.entity_type) params.set('entity_type', args.entity_type)
			const qs = params.toString()
			const path = qs ? `/api/subscriptions/unread?${qs}` : '/api/subscriptions/unread'
			const result = await apiCall(config, 'GET', path, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('list_unread', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Sessions ─────────────────────────────────────────────
	registerAppTool(
		server,
		'create_session',
		{
			description: tools.create_session.description,
			inputSchema: tools.create_session.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = (await apiCall(config, 'POST', '/api/sessions', body, {
				workspaceId: workspace_id,
			})) as SessionRow
			const wsId = workspace_id ?? config.defaultWorkspaceId
			const enriched = await enrichSessionActorName(config, wsId, result)
			const withUrl = wsId
				? addUrl(enriched as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: enriched.id,
						actorId: (enriched as { actorId?: string }).actorId,
					})
				: enriched
			return {
				_meta: meta('create_session', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_sessions',
		{
			description: tools.list_sessions.description,
			inputSchema: tools.list_sessions.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.status) params.set('status', args.status)
			if (args.actor_id) params.set('actor_id', args.actor_id)
			if (args.updated_before) params.set('updated_before', args.updated_before)
			if (args.updated_after) params.set('updated_after', args.updated_after)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const [result, names] = await Promise.all([
				apiCall(config, 'GET', `/api/sessions?${params}`, undefined, {
					workspaceId: args.workspace_id,
				}) as Promise<SessionRow[]>,
				wsId ? fetchActorNameMap(config, wsId) : Promise.resolve({} as Record<string, string>),
			])
			const enriched = result.map((s) => attachActorName(s, names))
			const withUrls = wsId
				? enriched.map((s) =>
						addUrl(s as Record<string, unknown>, config, wsId, {
							kind: 'session',
							id: s.id,
							actorId: (s as { actorId?: string }).actorId,
						}),
					)
				: enriched
			return {
				_meta: meta('list_sessions', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrls, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_session',
		{
			description: tools.get_session.description,
			inputSchema: tools.get_session.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const wsOpts = { workspaceId: args.workspace_id }
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const session = (await apiCall(
				config,
				'GET',
				`/api/sessions/${args.id}`,
				undefined,
				wsOpts,
			)) as SessionRow
			const enriched = await enrichSessionActorName(config, wsId, session)
			const sessionWithUrl = wsId
				? addUrl(enriched as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: enriched.id,
						actorId: (enriched as { actorId?: string }).actorId,
					})
				: enriched

			if (args.include_logs) {
				const params = new URLSearchParams()
				if (args.log_limit) params.set('limit', String(args.log_limit))
				const logs = await apiCall(
					config,
					'GET',
					`/api/sessions/${args.id}/logs?${params}`,
					undefined,
					wsOpts,
				)
				return {
					_meta: meta('get_session', config, (args as { workspace_id?: string }).workspace_id),
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ session: sessionWithUrl, logs }, null, 2),
						},
					],
				}
			}

			return {
				_meta: meta('get_session', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(sessionWithUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'stop_session',
		{
			description: tools.stop_session.description,
			inputSchema: tools.stop_session.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'POST', `/api/sessions/${args.id}/stop`, undefined, {
				workspaceId: args.workspace_id,
			})) as SessionRow
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched = await enrichSessionActorName(config, wsId, result)
			const withUrl = wsId
				? addUrl(enriched as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: enriched.id,
						actorId: (enriched as { actorId?: string }).actorId,
					})
				: enriched
			return {
				_meta: meta('stop_session', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'pause_session',
		{
			description: tools.pause_session.description,
			inputSchema: tools.pause_session.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'POST', `/api/sessions/${args.id}/pause`, undefined, {
				workspaceId: args.workspace_id,
			})) as SessionRow
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched = await enrichSessionActorName(config, wsId, result)
			const withUrl = wsId
				? addUrl(enriched as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: enriched.id,
						actorId: (enriched as { actorId?: string }).actorId,
					})
				: enriched
			return {
				_meta: meta('pause_session', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'resume_session',
		{
			description: tools.resume_session.description,
			inputSchema: tools.resume_session.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'POST', `/api/sessions/${args.id}/resume`, undefined, {
				workspaceId: args.workspace_id,
			})) as SessionRow
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const enriched = await enrichSessionActorName(config, wsId, result)
			const withUrl = wsId
				? addUrl(enriched as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: enriched.id,
						actorId: (enriched as { actorId?: string }).actorId,
					})
				: enriched
			return {
				_meta: meta('resume_session', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'run_agent',
		{
			description: tools.run_agent.description,
			inputSchema: tools.run_agent.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const { workspace_id } = args
			const wsOpts = { workspaceId: workspace_id }

			// 1. Create session
			const session = (await apiCall(
				config,
				'POST',
				'/api/sessions',
				{
					actor_id: args.actor_id,
					action_prompt: args.action_prompt,
					config: args.config,
					auto_start: true,
				},
				wsOpts,
			)) as { id: string; status: string }

			const sessionId = session.id
			const pollMs = (args.poll_interval_seconds ?? 5) * 1000
			const timeoutMs = (args.timeout_seconds ?? 660) * 1000
			const deadline = Date.now() + timeoutMs
			const terminalStatuses = ['completed', 'failed', 'timeout']

			// 2. Poll until terminal
			let current = session
			while (Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, pollMs))
				current = (await apiCall(
					config,
					'GET',
					`/api/sessions/${sessionId}`,
					undefined,
					wsOpts,
				)) as typeof session
				if (terminalStatuses.includes(current.status)) break
			}

			// 3. Fetch logs
			const logs = await apiCall(
				config,
				'GET',
				`/api/sessions/${sessionId}/logs?limit=500`,
				undefined,
				wsOpts,
			)

			const wsId = workspace_id ?? config.defaultWorkspaceId
			const currentWithUrl = wsId
				? addUrl(current as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: (current as { id?: string }).id ?? sessionId,
						actorId: (current as { actorId?: string }).actorId,
					})
				: current

			return {
				_meta: meta('run_agent', config, (args as { workspace_id?: string }).workspace_id),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ session: currentWithUrl, logs }, null, 2),
					},
				],
			}
		},
	)

	// ─── Integrations ─────────────────────────────────────────
	registerAppTool(
		server,
		'list_integrations',
		{
			description: tools.list_integrations.description,
			inputSchema: tools.list_integrations.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'GET', '/api/integrations', undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('list_integrations', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_integration_providers',
		{
			description: tools.list_integration_providers.description,
			inputSchema: tools.list_integration_providers.inputSchema.shape,
			_meta: {},
		},
		async () => {
			const result = await apiCall(config, 'GET', '/api/integrations/providers', undefined, {
				skipWorkspace: true,
			})
			return {
				_meta: meta('list_integration_providers', config),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'connect_integration',
		{
			description: tools.connect_integration.description,
			inputSchema: tools.connect_integration.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = (await apiCall(
				config,
				'POST',
				`/api/integrations/${args.provider}/connect`,
				undefined,
				{ workspaceId: args.workspace_id },
			)) as {
				install_url: string
			}
			return {
				_meta: meta(
					'connect_integration',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [
					{
						type: 'text' as const,
						text: `Open this URL in your browser to complete the installation:\n\n${result.install_url}\n\n${JSON.stringify(result, null, 2)}`,
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'disconnect_integration',
		{
			description: tools.disconnect_integration.description,
			inputSchema: tools.disconnect_integration.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/integrations/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta(
					'disconnect_integration',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── LLM API Keys ─────────────────────────────────────────
	// Wraps PATCH /api/workspaces/:id with settings.llm_keys. The server deep-
	// merges `llm_keys`, so a single-provider update preserves the others and
	// `null` signals deletion — no read-modify-write dance needed here.
	const last4 = (s: string) => (s.length <= 4 ? s : s.slice(-4))

	registerAppTool(
		server,
		'set_llm_api_key',
		{
			description: tools.set_llm_api_key.description,
			inputSchema: tools.set_llm_api_key.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			await apiCall(
				config,
				'PATCH',
				`/api/workspaces/${args.workspace_id ?? config.defaultWorkspaceId}`,
				{ settings: { llm_keys: { [args.provider]: args.api_key } } },
				{ workspaceId: args.workspace_id },
			)
			const result = { success: true, provider: args.provider, last4: last4(args.api_key) }
			return {
				_meta: meta('set_llm_api_key', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_llm_api_keys',
		{
			description: tools.get_llm_api_keys.description,
			inputSchema: tools.get_llm_api_keys.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			if (!wsId) throw new Error(`No workspace specified. ${workspaceSetupHint(config)}`)
			const ws = await getWorkspace(config, wsId)
			const llmKeys = (ws.settings.llm_keys ?? {}) as Record<string, string>
			const providerStatus = (key?: string) =>
				key ? { set: true, last4: last4(key) } : { set: false }
			const result = {
				anthropic: providerStatus(llmKeys.anthropic),
				openai: providerStatus(llmKeys.openai),
			}
			return {
				_meta: meta('get_llm_api_keys', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_llm_api_key',
		{
			description: tools.delete_llm_api_key.description,
			inputSchema: tools.delete_llm_api_key.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			await apiCall(
				config,
				'PATCH',
				`/api/workspaces/${args.workspace_id ?? config.defaultWorkspaceId}`,
				{ settings: { llm_keys: { [args.provider]: null } } },
				{ workspaceId: args.workspace_id },
			)
			const result = { success: true, provider: args.provider }
			return {
				_meta: meta('delete_llm_api_key', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Claude Subscription ──────────────────────────────────
	registerAppTool(
		server,
		'import_claude_subscription',
		{
			description: tools.import_claude_subscription.description,
			inputSchema: tools.import_claude_subscription.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(
				config,
				'POST',
				'/api/claude-oauth/import',
				{
					accessToken: args.access_token,
					refreshToken: args.refresh_token,
					expiresAt: args.expires_at,
					subscriptionType: args.subscription_type,
					scopes: args.scopes,
				},
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta(
					'import_claude_subscription',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_claude_subscription_status',
		{
			description: tools.get_claude_subscription_status.description,
			inputSchema: tools.get_claude_subscription_status.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'GET', '/api/claude-oauth/status', undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta(
					'get_claude_subscription_status',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'disconnect_claude_subscription',
		{
			description: tools.disconnect_claude_subscription.description,
			inputSchema: tools.disconnect_claude_subscription.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', '/api/claude-oauth', undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta(
					'disconnect_claude_subscription',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Extensions ──────────────────────────────────────────
	registerAppTool(
		server,
		'list_extensions',
		{
			description: tools.list_extensions.description,
			inputSchema: tools.list_extensions.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const modules = getAllModules()
			let enabledModuleIds: string[] = ['work']
			let workspaceSettings: Record<string, unknown> = {}
			try {
				const workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
					skipWorkspace: true,
				})) as Array<{ id: string; name: string; settings: Record<string, unknown> }>
				const effectiveWsId = args.workspace_id ?? config.defaultWorkspaceId
				const workspace = effectiveWsId
					? workspaces.find((w) => w.id === effectiveWsId)
					: workspaces[0]
				if (workspace?.settings) {
					workspaceSettings = workspace.settings
					if (workspace.settings.enabled_modules) {
						enabledModuleIds = workspace.settings.enabled_modules as string[]
					}
				}
			} catch {
				// Best-effort workspace lookup
			}

			const { statuses, displayNames, fieldDefs, relTypes, customExtensions } =
				extractSettings(workspaceSettings)

			// Collect all type keys owned by modules
			const moduleTypeKeys = new Set<string>()
			// Collect all type keys owned by tracked custom extensions
			const customExtTypeKeys = new Set<string>()

			// 1. Registered modules as extensions
			const moduleExtensions = modules.map((mod) => {
				for (const t of mod.objectTypes) moduleTypeKeys.add(t.type)
				return {
					id: mod.id,
					name: mod.name,
					enabled: enabledModuleIds.includes(mod.id),
					object_types: mod.objectTypes.map((t) => ({
						type: t.type,
						display_name: displayNames[t.type] ?? t.label,
						statuses: statuses[t.type] ?? t.defaultStatuses,
						fields:
							(fieldDefs[t.type] as Array<{ name: string; type: string }>) ?? t.defaultFields ?? [],
						relationship_types: t.defaultRelationshipTypes,
					})),
				}
			})

			// 2. Tracked custom extensions
			const trackedCustomExtensions = Object.entries(customExtensions).map(([extId, ext]) => {
				for (const t of ext.types) customExtTypeKeys.add(t)
				return {
					id: extId,
					name: ext.name,
					enabled: ext.enabled !== false,
					object_types: ext.types
						.filter((t) => t in statuses)
						.map((t) => ({
							type: t,
							display_name: displayNames[t] ?? t,
							statuses: statuses[t],
							fields: fieldDefs[t] ?? [],
							relationship_types: ext.relationship_types ?? [],
						})),
				}
			})

			// 3. Untracked custom types (not owned by any module or tracked extension)
			const untrackedTypes = Object.keys(statuses).filter(
				(t) => !moduleTypeKeys.has(t) && !customExtTypeKeys.has(t),
			)
			const untrackedExtensions =
				untrackedTypes.length > 0
					? [
							{
								id: 'custom',
								name: 'Custom Types',
								enabled: true,
								object_types: untrackedTypes.map((t) => ({
									type: t,
									display_name: displayNames[t] ?? t,
									statuses: statuses[t],
									fields: fieldDefs[t] ?? [],
									relationship_types: relTypes,
								})),
							},
						]
					: []

			const result = [...moduleExtensions, ...trackedCustomExtensions, ...untrackedExtensions]

			return {
				_meta: meta('list_extensions', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'create_extension',
		{
			description: tools.create_extension.description,
			inputSchema: tools.create_extension.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			// Check if this is a known module
			const allModules = getAllModules()
			const mod = allModules.find((m) => m.id === args.id)

			if (mod) {
				if (args.object_types && args.object_types.length > 0) {
					throw new Error(
						`"${args.id}" is a registered extension and cannot have custom object_types. Call create_extension with just the id to enable it, or choose a different id for your custom extension.`,
					)
				}

				// Enable module
				const workspace = await getWorkspace(config, args.workspace_id)
				const settings = (workspace.settings ?? {}) as Record<string, unknown>
				const enabledModules = Array.isArray(settings.enabled_modules)
					? (settings.enabled_modules as string[])
					: ['work']

				if (enabledModules.includes(args.id)) {
					return {
						_meta: meta(
							'create_extension',
							config,
							(args as { workspace_id?: string }).workspace_id,
						),
						content: [
							{
								type: 'text' as const,
								text: `Extension "${args.id}" is already enabled.`,
							},
						],
					}
				}

				const updatedSettings = buildEnableModuleSettings(args.id, settings)

				const result = await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${args.workspace_id}`,
					{ settings: updatedSettings },
					{ workspaceId: args.workspace_id },
				)

				return {
					_meta: meta('create_extension', config, (args as { workspace_id?: string }).workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				}
			}

			// Custom extension — create object types
			if (!args.object_types || args.object_types.length === 0) {
				const available = allModules.map((m) => m.id).join(', ')
				throw new Error(
					`Extension "${args.id}" is not a known extension. Available: ${available}. To create a custom extension, provide object_types.`,
				)
			}

			const workspace = await getWorkspace(config, args.workspace_id)
			const settings = (workspace.settings ?? {}) as Record<string, unknown>
			const { statuses, displayNames, fieldDefs, relTypes, customExtensions } =
				extractSettings(settings)

			if (args.id in customExtensions) {
				throw new Error(
					`Custom extension "${args.id}" already exists. Use update_extension to modify it.`,
				)
			}

			const extRelTypes: string[] = []
			for (const ot of args.object_types) {
				if (ot.type in statuses) {
					throw new Error(
						`Object type "${ot.type}" already exists. Use update_extension to modify it.`,
					)
				}
				statuses[ot.type] = ot.statuses
				displayNames[ot.type] = ot.display_name
				if (ot.fields && ot.fields.length > 0) {
					fieldDefs[ot.type] = ot.fields
				}
				if (ot.relationship_types) {
					for (const rt of ot.relationship_types) {
						if (!relTypes.includes(rt)) relTypes.push(rt)
						if (!extRelTypes.includes(rt)) extRelTypes.push(rt)
					}
				}
			}

			// Track the custom extension metadata
			customExtensions[args.id] = {
				name: args.name ?? args.id,
				types: args.object_types.map((ot) => ot.type),
				enabled: true,
				...(extRelTypes.length > 0 ? { relationship_types: extRelTypes } : {}),
			}

			const updatedSettings: Record<string, unknown> = {
				statuses,
				display_names: displayNames,
				field_definitions: fieldDefs,
				relationship_types: relTypes,
				custom_extensions: customExtensions,
			}

			const result = await apiCall(
				config,
				'PATCH',
				`/api/workspaces/${args.workspace_id}`,
				{ settings: updatedSettings },
				{ workspaceId: args.workspace_id },
			)

			return {
				_meta: meta('create_extension', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'update_extension',
		{
			description: tools.update_extension.description,
			inputSchema: tools.update_extension.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const workspace = await getWorkspace(config, args.workspace_id)
			const settings = (workspace.settings ?? {}) as Record<string, unknown>

			// Handle enable/disable
			if (args.enabled !== undefined) {
				const enabledModules = Array.isArray(settings.enabled_modules)
					? [...(settings.enabled_modules as string[])]
					: ['work']

				// Check if it's a custom extension — handle enable/disable in one place
				const { customExtensions } = extractSettings(settings)
				if (args.id in customExtensions) {
					const updatedCustomExts = { ...customExtensions }
					const existing = updatedCustomExts[args.id]
					if (existing) {
						updatedCustomExts[args.id] = { ...existing, enabled: args.enabled }
					}

					const result = await apiCall(
						config,
						'PATCH',
						`/api/workspaces/${args.workspace_id}`,
						{
							settings: {
								custom_extensions: updatedCustomExts,
							},
						},
						{ workspaceId: args.workspace_id },
					)

					return {
						_meta: meta(
							'update_extension',
							config,
							(args as { workspace_id?: string }).workspace_id,
						),
						content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
					}
				}

				if (args.enabled) {
					// Enable — check if it's a registered module
					const allModules = getAllModules()
					const mod = allModules.find((m) => m.id === args.id)
					if (mod) {
						if (enabledModules.includes(args.id)) {
							return {
								_meta: meta(
									'update_extension',
									config,
									(args as { workspace_id?: string }).workspace_id,
								),
								content: [
									{
										type: 'text' as const,
										text: `Extension "${args.id}" is already enabled.`,
									},
								],
							}
						}

						const updatedSettings = buildEnableModuleSettings(args.id, settings)

						const result = await apiCall(
							config,
							'PATCH',
							`/api/workspaces/${args.workspace_id}`,
							{ settings: updatedSettings },
							{ workspaceId: args.workspace_id },
						)

						return {
							_meta: meta(
								'update_extension',
								config,
								(args as { workspace_id?: string }).workspace_id,
							),
							content: [
								{
									type: 'text' as const,
									text: JSON.stringify(result, null, 2),
								},
							],
						}
					}

					// Not a registered module or custom extension
					throw new Error(
						`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
					)
				}

				if (!enabledModules.includes(args.id)) {
					return {
						_meta: meta(
							'update_extension',
							config,
							(args as { workspace_id?: string }).workspace_id,
						),
						content: [
							{
								type: 'text' as const,
								text: `Extension "${args.id}" is not currently enabled.`,
							},
						],
					}
				}

				const result = await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${args.workspace_id}`,
					{
						settings: {
							enabled_modules: enabledModules.filter((id) => id !== args.id),
						},
					},
					{ workspaceId: args.workspace_id },
				)

				return {
					_meta: meta('update_extension', config, (args as { workspace_id?: string }).workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				}
			}

			// Handle object type updates
			if (args.object_types && args.object_types.length > 0) {
				const { statuses, displayNames, fieldDefs, relTypes, customExtensions } =
					extractSettings(settings)

				// Determine which types this extension owns
				const allModules = getAllModules()
				const mod = allModules.find((m) => m.id === args.id)
				const customExt = customExtensions[args.id]
				const ownedTypes = new Set<string>()

				if (mod) {
					for (const t of mod.objectTypes) ownedTypes.add(t.type)
				} else if (customExt) {
					for (const t of customExt.types) ownedTypes.add(t)
				} else {
					throw new Error(
						`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
					)
				}

				const extRelTypes: string[] = customExt?.relationship_types
					? [...customExt.relationship_types]
					: []

				for (const ot of args.object_types) {
					if (!ownedTypes.has(ot.type)) {
						throw new Error(
							`Object type "${ot.type}" is not owned by extension "${args.id}". ` +
								`Types owned by this extension: ${[...ownedTypes].join(', ') || 'none'}.`,
						)
					}

					if (ot.statuses) statuses[ot.type] = ot.statuses
					if (ot.display_name) displayNames[ot.type] = ot.display_name
					if (ot.fields) fieldDefs[ot.type] = ot.fields
					if (ot.relationship_types) {
						for (const rt of ot.relationship_types) {
							if (!relTypes.includes(rt)) relTypes.push(rt)
							if (!extRelTypes.includes(rt)) extRelTypes.push(rt)
						}
					}
				}

				const updatedSettings: Record<string, unknown> = {
					statuses,
					display_names: displayNames,
					field_definitions: fieldDefs,
				}
				if (args.object_types.some((ot) => ot.relationship_types)) {
					updatedSettings.relationship_types = relTypes
				}

				// Update custom_extensions tracking metadata if this is a custom extension
				if (customExt) {
					customExtensions[args.id] = {
						...customExt,
						...(extRelTypes.length > 0 ? { relationship_types: extRelTypes } : {}),
					}
					updatedSettings.custom_extensions = customExtensions
				}

				const result = await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${args.workspace_id}`,
					{ settings: updatedSettings },
					{ workspaceId: args.workspace_id },
				)

				return {
					_meta: meta('update_extension', config, (args as { workspace_id?: string }).workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				}
			}

			throw new Error(
				'No changes specified. Provide enabled (true/false) to enable/disable, or object_types to update type definitions.',
			)
		},
	)

	registerAppTool(
		server,
		'delete_extension',
		{
			description: tools.delete_extension.description,
			inputSchema: tools.delete_extension.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			// Check if the extension is a registered module
			const allModules = getAllModules()
			const mod = allModules.find((m) => m.id === args.id)
			if (mod) {
				throw new Error(
					`Cannot delete "${args.id}" — it is a registered extension. Use update_extension with enabled: false to disable it instead.`,
				)
			}

			const workspace = await getWorkspace(config, args.workspace_id)
			const settings = (workspace.settings ?? {}) as Record<string, unknown>
			const { statuses, displayNames, fieldDefs, customExtensions } = extractSettings(settings)

			// Check if it's a tracked custom extension
			if (args.id in customExtensions) {
				const ext = customExtensions[args.id]
				if (!ext) throw new Error(`Extension ${args.id} not found`)
				const removed: string[] = []
				for (const type of ext.types) {
					// Don't remove types that are also provided by a module
					const isModuleType = allModules.some((m) => m.objectTypes.some((t) => t.type === type))
					if (!isModuleType && type in statuses) {
						delete statuses[type]
						delete displayNames[type]
						delete fieldDefs[type]
						removed.push(type)
					}
				}
				delete customExtensions[args.id]

				const updatedSettings: Record<string, unknown> = {
					statuses,
					display_names: displayNames,
					field_definitions: fieldDefs,
					custom_extensions: customExtensions,
					relationship_types: collectActiveRelTypes(
						{ ...settings, statuses, custom_extensions: customExtensions },
						allModules,
					),
				}

				const result = await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${args.workspace_id}`,
					{ settings: updatedSettings },
					{ workspaceId: args.workspace_id },
				)

				return {
					_meta: meta('delete_extension', config, (args as { workspace_id?: string }).workspace_id),
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ removed, workspace: result }, null, 2),
						},
					],
				}
			}

			// Fallback: check if the id matches a single type directly
			if (args.id in statuses) {
				// Check it's not a module type
				for (const m of allModules) {
					const provided = m.objectTypes.find((t) => t.type === args.id)
					if (provided) {
						throw new Error(
							`Cannot delete type "${args.id}" — it is provided by the "${m.name}" extension. Use update_extension with enabled: false to disable it instead.`,
						)
					}
				}

				delete statuses[args.id]
				delete displayNames[args.id]
				delete fieldDefs[args.id]

				// Clean up any custom extension that tracked this type
				for (const [extId, ext] of Object.entries(customExtensions)) {
					ext.types = ext.types.filter((t) => t !== args.id)
					if (ext.types.length === 0) {
						delete customExtensions[extId]
					}
				}

				const updatedSettings: Record<string, unknown> = {
					statuses,
					display_names: displayNames,
					field_definitions: fieldDefs,
					custom_extensions: customExtensions,
					relationship_types: collectActiveRelTypes(
						{ ...settings, statuses, custom_extensions: customExtensions },
						allModules,
					),
				}

				const result = await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${args.workspace_id}`,
					{ settings: updatedSettings },
					{ workspaceId: args.workspace_id },
				)

				return {
					_meta: meta('delete_extension', config, (args as { workspace_id?: string }).workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				}
			}

			throw new Error(
				`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
			)
		},
	)

	// ─── Widget telemetry ────────────────────────────────────
	// Called by rendered MCP widgets to report click-through and render
	// outcomes. Powers the bet's success metric (CTR on `Open in Maskin`) and
	// the 48h rolling render-error kill criterion. Intentionally NOT in
	// MUTATION_TOOL_KINDS — it's an instrumentation channel, not a write.
	registerAppTool(
		server,
		'record_widget_event',
		{
			description: tools.record_widget_event.description,
			inputSchema: tools.record_widget_event.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			recordWidgetEvent(telemetrySink, telemetryTarget, {
				widget_name: args.widget_name,
				event: args.event,
				tool_name: args.tool_name,
				card_kind: args.card_kind,
				object_type: args.object_type,
				object_id: args.object_id,
				workspace_id: args.workspace_id,
			})
			return {
				_meta: meta('record_widget_event', config, args.workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify({ recorded: true }) }],
			}
		},
	)

	// ─── Bet success metrics (read-only) ─────────────────────
	// Agent-callable surface for the MCP widget UX bet's success/kill metrics.
	// Wraps GET /api/telemetry/mcp/summary and returns only the bet-first widget
	// window — kept narrow so agents pull evidence without reading unrelated
	// rich-render / mutation aggregates they have no context for.
	registerAppTool(
		server,
		'get_bet_widget_metrics',
		{
			description: tools.get_bet_widget_metrics.description,
			inputSchema: tools.get_bet_widget_metrics.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const workspaceId = args.workspace_id ?? config.defaultWorkspaceId
			const summary = (await apiCall(config, 'GET', '/api/telemetry/mcp/summary', undefined, {
				workspaceId,
			})) as {
				workspace_id: string
				window_start: string
				window_end: string
				widget_bet_first_window: unknown
			}
			const result = {
				workspace_id: summary.workspace_id,
				window_start: summary.window_start,
				window_end: summary.window_end,
				widget_bet_first_window: summary.widget_bet_first_window,
			}
			return {
				_meta: meta('get_bet_widget_metrics', config, workspaceId),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Widget telemetry ────────────────────────────────────
	// Called by rendered MCP widgets to report click-through and render
	// outcomes. Powers the bet's success metric (CTR on `Open in Maskin`) and
	// the 48h rolling render-error kill criterion. Intentionally NOT in
	// ─── Get Started (Onboarding) ────────────────────────────
	registerAppTool(
		server,
		'get_started',
		{
			description: tools.get_started.description,
			inputSchema: tools.get_started.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const textResponse = (text: string) => ({
				_meta: meta('get_started', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text }],
			})

			// Resolve workspace
			let workspace: { id: string; name: string } | undefined
			try {
				const workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
					skipWorkspace: true,
				})) as Array<{ id: string; name: string }>
				const effectiveWsId = args.workspace_id ?? config.defaultWorkspaceId
				workspace =
					(effectiveWsId ? workspaces.find((w) => w.id === effectiveWsId) : workspaces[0]) ??
					workspaces[0]
			} catch {
				const setupSteps =
					config.transport === 'http'
						? "  1. Sign in at https://maskin.io and create a workspace\n  2. Copy your Maskin API key from Settings → API keys and your Workspace ID from Settings → Workspace\n  3. Reconnect Claude with `claude mcp add maskin --transport http --url https://maskin.io/mcp --header 'Authorization: Bearer <YOUR_MASKIN_API_KEY>' --header 'X-Workspace-Id: <YOUR_WORKSPACE_ID>'`\n  4. Run /reload-plugins, then call get_started again"
						: '  1. Call create_actor to get an API key\n  2. Restart with API_KEY set\n  3. Call get_started again'
				return textResponse(
					`👋 Welcome to Maskin!\n\nI can't reach your workspace yet. To finish setup:\n${setupSteps}\n\nOr pass a workspace_id directly if you have one.`,
				)
			}

			if (!workspace) {
				return textResponse(
					'👋 Welcome to Maskin!\n\nNo workspace found on this account. Call create_workspace first with a name, then run get_started again.',
				)
			}

			// PREVIEW: list marketplace packages so the user can pick one.
			if (!args.package_id || !args.confirm) {
				let packages: Array<{
					id: string
					name: string
					description: string
					use_case: string | null
					item_types: string[]
				}> = []
				try {
					const result = (await apiCall(config, 'GET', '/api/catalog/packages', undefined, {
						skipWorkspace: true,
					})) as {
						packages: Array<{
							id: string
							name: string
							description: string
							use_case: string | null
							item_types: string[]
						}>
					}
					packages = result.packages ?? []
				} catch (err) {
					return textResponse(`❌ Failed to fetch marketplace packages: ${String(err)}`)
				}

				if (packages.length === 0) {
					return textResponse(
						`👋 Welcome to Maskin!\n\nThe marketplace has no packages yet. Once packages are published you'll be able to install them here.\n\nIn the meantime, use the marketplace UI in the app to browse and install packages as they become available.`,
					)
				}

				const packageLines = packages.map((p) => {
					const types = p.item_types.length > 0 ? ` [${p.item_types.join(', ')}]` : ''
					const useCase = p.use_case ? ` · ${p.use_case}` : ''
					return `  • ${p.name}${useCase}${types}\n    ${p.description}\n    id: ${p.id}`
				})

				return textResponse(
					`👋 Welcome to Maskin! Let's set up "${workspace.name}".\n\nAvailable packages:\n\n${packageLines.join('\n\n')}\n\nAsk the user:\n  1. Which package would they like to install?\n  2. What should the workspace be named? (currently "${workspace.name}")\n\nThen call get_started again with:\n  package_id: "<id from above>"\n  confirm: true\n  workspace_name: "<name if they want to rename>"`,
				)
			}

			// INSTALL: rename workspace (if requested), then install the package.
			if (args.workspace_name && args.workspace_name.trim() !== workspace.name) {
				try {
					await apiCall(
						config,
						'PATCH',
						`/api/workspaces/${workspace.id}`,
						{ name: args.workspace_name.trim() },
						{ workspaceId: workspace.id },
					)
					workspace.name = args.workspace_name.trim()
				} catch (err) {
					return textResponse(
						`❌ Failed to rename workspace: ${String(err)}\n\nNothing else was applied. Retry with a different name, or omit workspace_name.`,
					)
				}
			}

			let installSummary = ''
			try {
				const result = (await apiCall(
					config,
					'POST',
					'/api/installed-packages',
					{ packageId: args.package_id, workspaceId: workspace.id },
					{ workspaceId: workspace.id },
				)) as { provisioned?: { actors: number; triggers: number; skills: number } }
				const p = result.provisioned
				if (p) {
					const parts = [
						p.actors > 0 ? `${p.actors} agent${p.actors === 1 ? '' : 's'}` : '',
						p.triggers > 0 ? `${p.triggers} trigger${p.triggers === 1 ? '' : 's'}` : '',
						p.skills > 0 ? `${p.skills} skill${p.skills === 1 ? '' : 's'}` : '',
					].filter(Boolean)
					installSummary =
						parts.length > 0 ? `Installed: ${parts.join(', ')}.` : 'Package installed.'
				}
			} catch (err) {
				return textResponse(`❌ Failed to install package: ${String(err)}`)
			}

			// Build magic login link (only safe on localhost).
			const frontendUrl = stripTrailingSlash(process.env.FRONTEND_URL ?? 'http://localhost:5173')
			const isLocalFrontend = (() => {
				try {
					const host = new URL(frontendUrl).hostname
					return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
				} catch {
					return false
				}
			})()
			const magicParams = new URLSearchParams()
			if (isLocalFrontend && config.apiKey) {
				magicParams.set('key', config.apiKey)
				try {
					const members = (await apiCall(
						config,
						'GET',
						`/api/workspaces/${workspace.id}/members`,
						undefined,
						{ workspaceId: workspace.id },
					)) as Array<{ actorId: string; name: string | null; email: string | null; type: string }>
					const human = members.find((m) => m.type === 'human') ?? members[0]
					if (human) {
						magicParams.set('actor_id', human.actorId)
						if (human.name) magicParams.set('actor_name', human.name)
						if (human.email) magicParams.set('actor_email', human.email)
						if (human.type) magicParams.set('actor_type', human.type)
					}
				} catch {
					// Best-effort; the frontend still works with just the key.
				}
			}
			const magicSuffix = magicParams.toString() ? `#${magicParams.toString()}` : ''
			const workspaceUrl = `${frontendUrl}/${workspace.id}${magicSuffix}`
			const keysUrl = `${frontendUrl}/${workspace.id}/settings/keys${magicSuffix}`

			// Check Claude subscription credentials. Agent sessions can't run without
			// them, so onboarding should prompt the user to add them. Best-effort.
			let claudeOauthConnected = false
			try {
				const oauthStatus = (await apiCall(config, 'GET', '/api/claude-oauth/status', undefined, {
					workspaceId: workspace.id,
				})) as { connected?: boolean; valid?: boolean }
				claudeOauthConnected = Boolean(oauthStatus.connected && oauthStatus.valid)
			} catch {
				// Best-effort; fall through to prompt the user.
			}

			const claudeCredsBlock = claudeOauthConnected
				? ''
				: `

INSTRUCTIONS FOR THE "Connect your Claude subscription" SECTION — render this BEFORE anything else. The agents in this workspace run Claude sessions, which need the user's Claude subscription credentials (you can't import them via MCP — the user has to paste them). Render EXACTLY this format:

  🔑 Connect your Claude subscription
     Open ${keysUrl} → "Import credentials" and paste the output of the terminal command shown there. Agents can't run until this is done.

Then on a NEW line, ask: "Let me know once that's done and I'll kick things off." Do NOT proceed to next steps until the user confirms credentials are imported (or explicitly says to skip). If they skip, flag that agent sessions will fail until credentials are added.`

			return textResponse(
				`✅ Package installed in workspace "${workspace.name}". ${installSummary}

🌐 Open the workspace: ${workspaceUrl}
${claudeCredsBlock}`,
			)
		},
	)

	// Register extension MCP tools (namespaced with extensionId prefix)
	for (const ext of getAllModules()) {
		for (const tool of ext.mcpTools ?? []) {
			try {
				registerAppTool(
					server,
					`${ext.id}_${tool.name}`,
					{
						description: `[${ext.name}] ${tool.description}`,
						inputSchema: tool.inputSchema.shape,
						_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
					},
					async (args) => {
						const result = await tool.handler(args, (method, path, body, options) =>
							apiCall(config, method, `/api/m/${ext.id}${path}`, body, options),
						)
						return {
							_meta: meta(
								`${ext.id}_${tool.name}`,
								config,
								(args as { workspace_id?: string }).workspace_id,
							),
							content: result.content,
						}
					},
				)
			} catch (err) {
				console.error(`Failed to register MCP tool '${ext.id}_${tool.name}':`, err)
			}
		}
	}

	return server
}

// CLI entry point
async function main() {
	const config: McpConfig = {
		apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
		apiKey: process.env.API_KEY || '',
		defaultWorkspaceId: process.env.DEFAULT_WORKSPACE_ID || process.env.WORKSPACE_ID || '',
		transport: 'stdio',
		webAppBaseUrl: resolveWebAppBaseUrl(process.env),
	}

	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('MCP server started (stdio transport)')
}

main().catch(console.error)
