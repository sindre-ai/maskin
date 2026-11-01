import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	type MentionNameResolution,
	type MentionParticipant,
	resolveMentionNames,
} from './mention-names'
import './extensions.js'
import { getAllModules, getModuleDefaultSettings } from '@maskin/module-sdk'
import {
	type CustomExtensionEntry,
	FOR_YOU_TOOL_DEFAULT_LIMIT,
	type ForYouItemLike,
	type McpEra,
	type McpProtocolVersionLabel,
	type ObjectPreview,
	type WebAppTarget,
	buildWebAppHref,
	resolveWebAppBaseUrl,
	slimForYouItems,
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
import type { z } from 'zod'
import { needsNormalise, normaliseArgs, wrapInputSchema } from './alias-layer.js'
import { READ_ONLY_TOOLS, TOOL_ANNOTATIONS } from './annotations.js'
import {
	CURSOR_MAX_OFFSET,
	type CursorState,
	decodeCursor,
	encodeCursor,
	paginateClientSide,
	toSnapshotAt,
} from './cursor.js'
import {
	type IntegrationRow,
	integrationSortKey,
	leanIntegrationRow,
	matchesIntegrationFilters,
	summarizeIntegrations,
} from './integrations-list.js'
import { buildListPayload, listText } from './list-response.js'
import {
	READ_TOOL_NAMES,
	buildReadErrorBody,
	parseApiErrorStatus,
	reasonFromError,
	toolErrorResponse,
} from './read-error.js'
import { RESUME_CURSOR, applyResponseTokenCap } from './response-cap.js'
import {
	type ApiCaller as SetupApiCaller,
	buildActorSetupBlockFromApi,
	buildBetSetupBlock,
	buildBetSetupBlockFromApi,
	buildLoopSetupBlockFromApi,
	composeLoopSteps,
	mergeBetSetupBlocks,
	readStatusOrder,
	readWorkspaceLlmReadiness,
	safeBuildSetupBlock,
} from './setup-guidance/index.js'
import {
	type ListActorsView,
	MUTATION_TOOL_KINDS,
	TELEMETRY_VIEW,
	type TelemetrySink,
	createDefaultSink,
	currentToolCallSeq,
	recordAliasUse,
	recordMutation,
	recordToolCall,
	recordToolCallResponseSize,
} from './telemetry.js'
import { RUN_AGENT_DROPPED_KEYS, TOOL_NAME_ALIASES } from './tool-aliases.js'
import { parseListActorsInclude, tools } from './tools.js'

export interface McpConfig {
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
	/**
	 * Session identity for telemetry, overriding the MCP process's own.
	 *
	 * Set by `routes/mcp.ts` on the HTTP transport, where this server is built
	 * per POST inside apps/dev and the process-scope id would be shared by
	 * every caller. Omitted on stdio. See `TelemetryConfig.sessionId`.
	 */
	telemetrySessionId?: string
	/** How `telemetrySessionId` was obtained. Ignored without it. */
	telemetrySessionSource?: 'maskin-session' | 'process' | 'unknown'
	/**
	 * Protocol era and allowlisted version label for telemetry, next to
	 * `transport`. Set by `routes/mcp.ts` from `classifyMcpEra` on HTTP; stdio
	 * sets the fallback (legacy, none) because the SDK does not expose the
	 * negotiated version on the server object. See `TelemetryConfig.mcpEra`.
	 */
	telemetryEra?: McpEra
	telemetryProtocolVersion?: McpProtocolVersionLabel
	/**
	 * `events.id` of the comment that dispatched this agent session, when the
	 * session was triggered by a comment. `create_comment` uses it as the
	 * default `parent_event_id` unless the caller explicitly opts out via
	 * `no_thread: true` — the tool-level guarantee that agents reply inside
	 * their triggering thread without depending on a prompt rule each system
	 * prompt has to remember (follow-up to PR #1709's rule-level fallback).
	 *
	 * Set by `routes/mcp.ts` from the `X-Maskin-Triggering-Event-Id` header
	 * that session-manager stamps onto Maskin MCP entries when a session
	 * carries `source_comment_event_id`. Absent otherwise, and always absent
	 * on stdio and on external callers.
	 */
	triggeringEventId?: number
	/**
	 * The caller's own session id, as sent in X-Maskin-Session-Id by the agent
	 * container. Over HTTP the MCP server runs inside apps/dev, so
	 * process.env.SESSION_ID is that process's, not the caller's; routes/mcp.ts
	 * passes the header through here and the API call prefers it. Unset on stdio
	 * (the container's own env is right there) and for callers without a session.
	 * Only a claim: the API checks it before acting on it.
	 */
	maskinSessionId?: string
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
 * Build the `content` text for a list/search tool response. Always returns
 * a compact `JSON.stringify(fullPayload)` — a lean markdown-summary channel
 * (one line per row, full payload only on `structuredContent`) was tried
 * under an earlier response-scoping flag but left agents without enough
 * detail in the `content` channel to act on, so every list/search tool
 * ships the full payload there. `structuredContent` always carries the full
 * enriched payload too.
 */
function buildListContentText(fullPayload: unknown): string {
	return JSON.stringify(fullPayload)
}

const CHAT_SNIPPET_MAX_LENGTH = 200

/** A chat message can run to thousands of characters; a list row only needs the opening. */
function truncateSnippet(text: string | null): string | null {
	if (text === null || text.length <= CHAT_SNIPPET_MAX_LENGTH) return text
	return `${text.slice(0, CHAT_SNIPPET_MAX_LENGTH - 1)}…`
}

/**
 * One line telling the agent which listed integrations are not live and how to
 * get them reconnected, or null when every row is active. `pending` rows are an
 * unfinished connect, not a broken connection, so they are left out.
 */
function buildReconnectHint(rows: Array<{ provider?: string; status?: string }>): string | null {
	const broken = new Map<string, string>()
	for (const row of rows) {
		if (!row.provider || !row.status || row.status === 'active' || row.status === 'pending') {
			continue
		}
		if (!broken.has(row.provider)) broken.set(row.provider, row.status)
	}
	if (broken.size === 0) return null
	const list = [...broken].map(([provider, status]) => `${provider} (${status})`).join(', ')
	return `Needs reconnecting: ${list}. To put a one-click Reconnect card in the chat, call connect_integration with that provider and end your turn. Do not tell the user to go to Settings.`
}

/**
 * Card keys on message metadata, mapped to the tool that really shows that card.
 * The server drops them from anything posted through post_conversation_message,
 * so a call that carried one used to succeed with the card silently missing.
 * A null tool means no agent tool shows that card at all.
 */
const CARD_METADATA_KEYS: Record<string, string | null> = {
	integration_connect: 'connect_integration',
	keychain_request: 'request_keychain_credential',
	keychain_access_request: 'request_keychain_access',
	mcp_server_request: 'add_mcp_server',
	computer_request: 'show_computer',
	question: 'ask_user_question',
	needed_tools: null,
}

/** Throws when message metadata carries a card key, naming the tool to use instead. */
function rejectCardMetadata(metadata: Record<string, unknown> | undefined): void {
	if (!metadata) return
	const found = Object.keys(CARD_METADATA_KEYS).filter((key) => metadata[key] !== undefined)
	if (found.length === 0) return
	const advice = found.map((key) => {
		const tool = CARD_METADATA_KEYS[key]
		return tool ? `${key}: call ${tool}` : `${key}: no agent tool shows this card`
	})
	throw new Error(
		`post_conversation_message cannot render cards, so nothing was posted. Remove ${found.join(', ')} from metadata (${advice.join('; ')}). Never write card text yourself or tell the user a card is shown.`,
	)
}

/** Default page size when the caller did not pass an explicit limit. Kept
 *  in sync with `HERO_CARD_UI_PAGE_SIZE` — the UI has been paging at 25 for
 *  months, so an agent gets responses shaped like what a human sees in the
 *  widget. */
const DEFAULT_PAGE_SIZE = 25

/** Hard cap the `/api/objects` list + search endpoints enforce on `limit`
 *  (`objectQuerySchema` / `searchObjectsSchema` in `@maskin/shared`). The
 *  cursor `+ 1` sentinel below must stay strictly under this ceiling, so
 *  the effective page size is capped at `MAX - 1`. */
const LIST_ENDPOINT_MAX_LIMIT = 100

/**
 * Resolve the effective page size + cursor state for a list/search MCP
 * tool call. When the caller passes neither `limit` nor `cursor`, we cap
 * the page at `DEFAULT_PAGE_SIZE`. When a cursor is present, its snapshot +
 * last-seen keyset are threaded through to the API on every subsequent hop
 * so an insert in the underlying table mid-walk cannot leak into the
 * stream.
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

function resolveListPagination(args: {
	limit?: number
	cursor?: string
	/** Sort direction to open a fresh walk in when no cursor is present yet.
	 *  Ignored once a cursor exists — the walk stays locked to whatever
	 *  direction the first call opened it in. Defaults to `desc`; only
	 *  tools that expose their own sort-direction param (e.g. `list_objects`'
	 *  `sort=updated_at_asc`) need to pass this. */
	order?: 'asc' | 'desc'
	/** Largest page the tool can serve. Defaults to `MAX - 1` (room for the
	 *  `+ 1` sentinel); a tool that confirms "has more" some other way can pass
	 *  `LIST_ENDPOINT_MAX_LIMIT` to honour the full documented limit. */
	maxLimit?: number
}): ResolvedPagination {
	const cursor = decodeCursor(args.cursor)
	const requested =
		typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
			? args.limit
			: DEFAULT_PAGE_SIZE
	// We fetch `requested + 1` to detect "has more"; the API's list endpoints
	// reject any `limit > LIST_ENDPOINT_MAX_LIMIT`, so cap the effective page
	// at `MAX - 1` to keep the sentinel within bounds.
	const limit = Math.min(requested, args.maxLimit ?? LIST_ENDPOINT_MAX_LIMIT - 1)
	const snapshotAt = cursor?.s ?? toSnapshotAt(new Date())
	const order = cursor?.o ?? args.order ?? 'desc'
	return { limit, cursor, snapshotAt, order }
}

/**
 * Encode the next-cursor for a list tool response. Returns `null` when the
 * caller already reached the end of the walk — `rows.length < limit + 1`
 * means the API had nothing more to hand back.
 *
 * Reuses `snapshotAt` and `order` from `pagination`, so every hop of the
 * same walk agrees on the freeze even if the underlying table accepts
 * inserts between calls. `getSortValue` picks the field the walk is keyed
 * on — defaults to `createdAt`; `list_objects` passes `updatedAt` when its
 * `sort` param is set, since the API seeks on whichever column the walk is
 * actually ordered by.
 */
function encodeNextCursor<T extends { id: string; createdAt?: string | null }>(
	pagination: ResolvedPagination,
	rows: T[],
	getSortValue: (row: T) => string | null | undefined = (row) => row.createdAt,
): { nextCursor: string | null; trimmed: T[] } {
	if (rows.length <= pagination.limit) return { nextCursor: null, trimmed: rows }
	const trimmed = rows.slice(0, pagination.limit)
	const last = trimmed[trimmed.length - 1]
	const sortValue = last ? getSortValue(last) : null
	if (!last || !sortValue) return { nextCursor: null, trimmed }
	const nextCursor = encodeCursor({
		s: pagination.snapshotAt,
		o: pagination.order,
		k: { sortValue, id: last.id },
	})
	return { nextCursor, trimmed }
}

/**
 * One page of /api/events/history. The route has no cursor of its own, only
 * limit, offset and before, ordered newest first (createdAt desc, id desc). So
 * the walk is frozen by sending before = the snapshot time on every hop, and
 * the position travels in the cursor as an offset (n). Asks for one row past
 * the page: if it comes back there is a next page.
 */
async function fetchEventHistoryPage(
	config: McpConfig,
	params: URLSearchParams,
	pagination: ResolvedPagination,
	workspaceId: string | undefined,
) {
	const offset = pagination.cursor?.n ?? 0
	const query = new URLSearchParams(params)
	query.set('limit', String(pagination.limit + 1))
	query.set('offset', String(offset))
	query.set('before', pagination.snapshotAt)
	const result = await apiCall(config, 'GET', `/api/events/history?${query}`, undefined, {
		workspaceId,
	})
	const rows = Array.isArray(result)
		? (result as Array<{ id: number | string; createdAt?: string | null }>)
		: []
	const page = rows.slice(0, pagination.limit)
	const last = page[page.length - 1]
	const nextOffset = offset + page.length
	// A next_cursor whose offset decodeCursor would refuse restarts the walk at the
	// top, so stop instead of looping.
	if (rows.length <= pagination.limit || !last?.createdAt || nextOffset > CURSOR_MAX_OFFSET) {
		return { page, nextCursor: null }
	}
	const nextCursor = encodeCursor({
		s: pagination.snapshotAt,
		o: pagination.order,
		k: { sortValue: last.createdAt, id: String(last.id) },
		n: nextOffset,
	})
	return { page, nextCursor }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
		// Tells the backend this call arrived through the MCP transport so
		// route-level analytics (knowledge_object_created / _read) can
		// attribute `created_via` / `accessed_via` without guessing.
		'X-Client-Source': 'mcp',
	}
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`
	}
	if (effectiveWorkspaceId) {
		headers['X-Workspace-Id'] = effectiveWorkspaceId
	}
	// S2 writer hook: attribute every MCP-tool-originated mutation to the
	// container session it ran inside, so the backend's `produced_by` writer
	// can persist a `session → object|file` edge. `SESSION_ID` is injected by
	// the host session-manager on container launch; running the MCP server
	// outside an agent session (local dev) leaves it unset and no header is
	// sent. Read-only calls carry the header too — cheap and harmless, and
	// keeps the header contract uniform per request rather than per method.
	const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
	if (sessionId && UUID_RE.test(sessionId)) {
		headers['X-Maskin-Session-Id'] = sessionId
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
		let apiErrorCode: string | null = null
		try {
			const errorData = JSON.parse(errorText)
			if (typeof errorData.error?.code === 'string' && errorData.error.code.length > 0) {
				apiErrorCode = errorData.error.code
			}
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
		const error = new Error(`API error ${response.status}: ${message}`)
		// Preserve the machine-readable `error.code` the backend sent alongside
		// the prose. Without it the LinkedIn taxonomy (CREDENTIAL_NOT_CONNECTED,
		// LINKEDIN_ACCOUNT_RESTRICTED, …) is unrecoverable downstream, and
		// classifyReadError falls back to "unknown" — whose guidance tells the
		// caller to retry, the one action a restricted LinkedIn account must
		// never take. Attached as a property rather than folded into the message
		// so `parseApiErrorStatus`'s regex keeps working unchanged.
		if (apiErrorCode !== null) {
			;(error as Error & { apiErrorCode?: string }).apiErrorCode = apiErrorCode
		}
		throw error
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

/**
 * Adapts `apiCall` to the arity the setup-guidance wiring expects, closing over
 * `config` so callers pass method/path/body/options only.
 */
function setupApiCaller(config: McpConfig): SetupApiCaller {
	return (method, path, body, options) => apiCall(config, method, path, body, options)
}

/** Count configured MCP servers on an actor's `tools`, excluding the built-in `maskin` entry. */
function countNonMaskinMcpServers(tools: unknown): number {
	const mcpServers = (tools as { mcpServers?: Record<string, unknown> } | null | undefined)
		?.mcpServers
	if (!mcpServers || typeof mcpServers !== 'object') return 0
	return Object.keys(mcpServers).filter((name) => name !== 'maskin').length
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

/** Relationship type marking "this object is a member of this loop's
 * pipeline" — source is the loop object, target is the member object.
 * Mirrors LOOP_MEMBERSHIP_RELATIONSHIP_TYPE in apps/dev/src/routes/loops.ts. */
const LOOP_MEMBERSHIP_TYPE = 'in_loop'

/** Page size when walking a loop's `in_loop` edges — the API's max. */
const RELATIONSHIP_PAGE_LIMIT = 100

/**
 * Validate that every id in `triggerIds` is a real trigger in the workspace.
 * GET /api/triggers returns the complete, unpaginated list when called with no
 * query params, so a single call covers the whole workspace. Throws with the
 * unknown ids named — a typo'd trigger id must fail loudly here, because the
 * loops read API silently drops unknown ids and the loop would otherwise
 * render with no steps and no agents.
 */
async function assertTriggersExist(
	config: McpConfig,
	triggerIds: string[],
	workspaceId?: string,
): Promise<void> {
	if (triggerIds.length === 0) return
	const rows = (await apiCall(config, 'GET', '/api/triggers', undefined, {
		workspaceId,
	})) as Array<{ id: string }>
	const known = new Set(Array.isArray(rows) ? rows.map((r) => r.id) : [])
	const unknown = triggerIds.filter((id) => !known.has(id))
	if (unknown.length > 0) {
		throw new Error(
			`Unknown trigger id(s): ${unknown.join(', ')}. A loop's steps must be existing triggers in the workspace — create them first with create_trigger, or find them with list_triggers.`,
		)
	}
}

/**
 * Validate that every id in `objectIds` is a real object in the workspace the
 * loop lives in. The relationships/graph endpoints only check UUID *format*,
 * so without this a mistyped id would create a dangling `in_loop` edge that
 * never shows up in the loop's stats. Throws with the bad ids named.
 */
async function assertObjectsExist(
	config: McpConfig,
	objectIds: string[],
	workspaceId?: string,
): Promise<void> {
	if (objectIds.length === 0) return
	const effectiveWs = workspaceId ?? config.defaultWorkspaceId
	const results = await Promise.all(
		objectIds.map(async (id) => {
			try {
				const obj = (await apiCall(config, 'GET', `/api/objects/${id}`, undefined, {
					workspaceId,
				})) as { id?: string; workspaceId?: string }
				if (effectiveWs && obj.workspaceId && obj.workspaceId !== effectiveWs) {
					return { id, ok: false }
				}
				return { id, ok: true }
			} catch {
				return { id, ok: false }
			}
		}),
	)
	const unknown = results.filter((r) => !r.ok).map((r) => r.id)
	if (unknown.length > 0) {
		throw new Error(
			`Unknown object id(s) in this workspace: ${unknown.join(', ')}. Loop member objects must already exist — find them with list_objects or search_objects, or create them with create_objects first.`,
		)
	}
}

/**
 * Validate that every id in `agentIds` is a real, workspace-member actor of
 * type 'agent'. Without this, a step's `agent_id` is only checked for UUID
 * format — a hallucinated or stale id would create an `enabled: true`
 * trigger that resolves to no working agent, silently defeating the step.
 * Uses the workspace-scoped `GET /api/actors?ids=` listing (not
 * `GET /api/actors/:id`, which is not workspace-scoped) so a real actor from
 * a different workspace, or one not a member of this one, is correctly
 * rejected. Throws with the bad ids named and why (missing vs. wrong type).
 */
async function assertAgentsExist(
	config: McpConfig,
	agentIds: string[],
	workspaceId?: string,
): Promise<void> {
	const ids = [...new Set(agentIds)]
	if (ids.length === 0) return
	const rows = (await apiCall(
		config,
		'GET',
		`/api/actors?ids=${ids.map(encodeURIComponent).join(',')}`,
		undefined,
		{ workspaceId },
	)) as Array<{ id: string; type: string }>
	const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.id, r.type]))

	const missing = ids.filter((id) => !byId.has(id))
	const wrongType = ids.filter((id) => byId.has(id) && byId.get(id) !== 'agent')
	if (missing.length === 0 && wrongType.length === 0) return

	const parts: string[] = []
	if (missing.length > 0) {
		parts.push(
			`not found or not a member of this workspace: ${missing.join(', ')} (create one with create_actor, or find one with list_actors)`,
		)
	}
	if (wrongType.length > 0) {
		parts.push(
			`not an agent actor: ${wrongType.join(', ')} (a step's agent_id must target an agent — put a human on the loop by having a step's agent notify/@mention them instead)`,
		)
	}
	throw new Error(`Invalid step agent_id(s) — ${parts.join('; ')}.`)
}

/**
 * Delete every `in_loop` edge for a loop (source = loop, no target filter) —
 * used by delete_loop. `relationships` rows have no FK/cascade from either
 * side, so these are orphaned unless explicitly cleaned up before the loop
 * object itself is deleted. Returns the member object ids that were detached.
 */
async function deleteAllLoopMemberships(
	config: McpConfig,
	loopId: string,
	workspaceId?: string,
): Promise<string[]> {
	const removedObjectIds: string[] = []
	// Always re-fetch at offset 0: deleting a page shifts the remaining rows
	// down, so a fixed offset would skip rows (the same hazard update_loop's
	// remove_object_ids avoids by collecting before deleting — this avoids it
	// by never advancing past what's already been deleted).
	for (;;) {
		const page = (await apiCall(
			config,
			'GET',
			`/api/relationships?source_id=${loopId}&type=${LOOP_MEMBERSHIP_TYPE}&limit=${RELATIONSHIP_PAGE_LIMIT}&offset=0`,
			undefined,
			{ workspaceId },
		)) as Array<{ id: string; targetId: string }>
		if (!Array.isArray(page) || page.length === 0) break
		for (const rel of page) {
			await apiCall(config, 'DELETE', `/api/relationships/${rel.id}`, undefined, { workspaceId })
			removedObjectIds.push(rel.targetId)
		}
	}
	return removedObjectIds
}

/** Inline loop-step input shape — mirrors `loopStepSchema` in tools.ts. */
interface LoopStepInput {
	name: string
	agent_id: string
	prompt: string
	when:
		| { cron: string }
		| {
				object_type: string
				action: 'created' | 'updated' | 'status_changed' | 'deleted'
				filter?: Record<string, unknown>
		  }
}

/**
 * Map an inline loop step to a `POST /api/triggers` request body. `enabled`
 * defaults to true; callers creating steps on a loop whose effective status
 * is `paused` pass `false` so a newly-authored step doesn't start firing on
 * a loop that isn't supposed to be running anything yet.
 */
function buildStepTriggerBody(step: LoopStepInput, enabled = true): Record<string, unknown> {
	if ('cron' in step.when) {
		return {
			name: step.name,
			type: 'cron',
			config: { expression: step.when.cron },
			action_prompt: step.prompt,
			target_actor_id: step.agent_id,
			enabled,
		}
	}
	const triggerConfig: Record<string, unknown> = {
		action: step.when.action,
		entity_type: step.when.object_type,
	}
	if (step.when.filter) triggerConfig.filter = step.when.filter
	return {
		name: step.name,
		type: 'event',
		config: triggerConfig,
		action_prompt: step.prompt,
		target_actor_id: step.agent_id,
		enabled,
	}
}

/**
 * Best-effort disable/enable a batch of triggers (used when a loop is
 * created/updated with an effective status of `paused`, or leaves `paused`).
 * Returns the ids that failed to update rather than throwing — a loop write
 * must not fail just because one trigger PATCH hiccuped; the caller surfaces
 * failures in the response instead of silently swallowing them.
 */
async function setTriggersEnabled(
	config: McpConfig,
	triggerIds: string[],
	enabled: boolean,
	workspaceId: string | undefined,
): Promise<string[]> {
	const failed: string[] = []
	await Promise.all(
		triggerIds.map(async (triggerId) => {
			try {
				await apiCall(config, 'PATCH', `/api/triggers/${triggerId}`, { enabled }, { workspaceId })
			} catch {
				failed.push(triggerId)
			}
		}),
	)
	return failed
}

/**
 * Fetch the resolved step view (trigger + nested agent) for a loop's
 * trigger ids — the same `composeLoopSteps` shape the `setup` block uses,
 * reused here so create_loop/update_loop responses show agents nested under
 * their trigger instead of a bare id list. Best-effort: a fetch failure
 * degrades to an empty array rather than failing the primary write.
 */
async function fetchLoopStepsView(
	config: McpConfig,
	workspaceId: string | undefined,
	triggerIds: string[],
): Promise<ReturnType<typeof composeLoopSteps>> {
	if (triggerIds.length === 0) return []
	try {
		const triggerRows = await apiCall(config, 'GET', '/api/triggers', undefined, { workspaceId })
		const matchedTriggers = Array.isArray(triggerRows)
			? (triggerRows as Array<Record<string, unknown>>).filter((t) =>
					triggerIds.includes(t.id as string),
				)
			: []
		const agentIds = Array.from(
			new Set(
				matchedTriggers
					.map((t) => t.targetActorId)
					.filter((v): v is string => typeof v === 'string'),
			),
		)
		const actorRows =
			agentIds.length > 0
				? await apiCall(
						config,
						'GET',
						`/api/actors?ids=${agentIds.map(encodeURIComponent).join(',')}`,
						undefined,
						{ workspaceId },
					)
				: []
		return composeLoopSteps(triggerIds, matchedTriggers, actorRows)
	} catch (err) {
		console.error('[loops] failed to build steps view, degrading to empty:', err)
		return []
	}
}

/** Strip fields that don't apply to a loop (a loop is never driven or run
 *  directly — its steps are the triggers that do the work). */
function stripLoopOnlyFields(entity: Record<string, unknown>): Record<string, unknown> {
	const { driver: _driver, activeSessionId: _activeSessionId, ...rest } = entity
	return rest
}

/**
 * Validate the workspace-schema-dependent parts of a loop write: the
 * `closed_statuses` map (types and statuses must exist in the workspace's
 * settings — the same dynamic source `get_workspace_schema` reads) and any
 * step `when.object_type`. Skips the workspace fetch entirely when nothing
 * needs it. Throws with the offending values named and a pointer to
 * get_workspace_schema, so agents can self-correct.
 */
async function assertLoopTypesValid(
	config: McpConfig,
	input: {
		closedStatuses?: Record<string, string[]>
		closedWhen?: Record<string, string[]>
		steps?: LoopStepInput[]
	},
	workspaceId?: string,
): Promise<void> {
	const closedEntries = Object.entries(input.closedStatuses ?? {})
	const closedWhenTypes = Object.keys(input.closedWhen ?? {})
	const stepTypes = (input.steps ?? [])
		.map((s) => ('object_type' in s.when ? s.when.object_type : undefined))
		.filter((t): t is string => typeof t === 'string')
	if (closedEntries.length === 0 && closedWhenTypes.length === 0 && stepTypes.length === 0) return

	const wsId = workspaceId ?? config.defaultWorkspaceId
	if (!wsId) return // downstream calls raise the standard no-workspace hint
	const workspace = await getWorkspace(config, wsId)
	const statuses = (workspace.settings.statuses ?? {}) as Record<string, string[]>
	const knownTypes = Object.keys(statuses)

	for (const [type, wanted] of closedEntries) {
		if (!knownTypes.includes(type)) {
			throw new Error(
				`closed_statuses references unknown object type '${type}'. Known types: ${knownTypes.join(', ')}. Call get_workspace_schema to see the workspace's types, or add the type first with create_extension.`,
			)
		}
		const valid = statuses[type] ?? []
		const bad = wanted.filter((s) => !valid.includes(s))
		if (bad.length > 0) {
			throw new Error(
				`closed_statuses for type '${type}' references unknown status(es): ${bad.join(', ')}. Valid statuses for '${type}': ${valid.join(', ')}.`,
			)
		}
	}

	for (const type of closedWhenTypes) {
		if (!knownTypes.includes(type)) {
			throw new Error(
				`closed_when references unknown object type '${type}'. Known types: ${knownTypes.join(', ')}. Call get_workspace_schema to see the workspace's types.`,
			)
		}
	}

	for (const type of stepTypes) {
		if (!knownTypes.includes(type)) {
			throw new Error(
				`A step's when.object_type references unknown object type '${type}'. Known types: ${knownTypes.join(', ')}. Call get_workspace_schema to see the workspace's types.`,
			)
		}
	}
}

async function getWorkspace(
	config: McpConfig,
	workspaceId: string,
): Promise<{
	id: string
	name: string
	settings: Record<string, unknown>
	llm_configured?: { anthropic?: boolean; openai?: boolean }
}> {
	const workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
		skipWorkspace: true,
	})) as Array<{
		id: string
		name: string
		settings: Record<string, unknown>
		llm_configured?: { anthropic?: boolean; openai?: boolean }
	}>
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

/** A session row as the tools return it: with the agent's name and a link to it. */
async function presentSession(
	config: McpConfig,
	workspaceId: string | undefined,
	row: SessionRow,
): Promise<SessionRow> {
	const enriched = await enrichSessionActorName(config, workspaceId, row)
	return workspaceId
		? (addUrl(enriched as Record<string, unknown>, config, workspaceId, {
				kind: 'session',
				id: enriched.id,
				actorId: (enriched as { actorId?: string }).actorId,
			}) as SessionRow)
		: enriched
}

/** Failure of a tool call when the session is not in a state the tool works on. */
function sessionStateError(status: string, id: string): Error {
	if (status === 'running') {
		return new Error(
			`Session ${id} is still running, so there is nothing to resume. Talk to it with send_session_message, or wait for it with get_session (wait: true).`,
		)
	}
	return new Error(
		`Session ${id} is ${status}, which is not something to resume or continue yet. Check it with get_session (wait: true to hold until it is done) and try again once it is paused or has ended.`,
	)
}

/** A running interactive session accepts a message; anything else says why not. */
async function sendSessionInput(
	config: McpConfig,
	workspaceId: string | undefined,
	id: string,
	content: string,
): Promise<void> {
	try {
		await apiCall(
			config,
			'POST',
			`/api/sessions/${id}/input`,
			{ content },
			{
				workspaceId,
			},
		)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw new Error(
			/not running/i.test(message)
				? `${message}. A session that is paused or has ended is carried on with resume_session, which also takes a message.`
				: message,
		)
	}
}

const ENDED_SESSION_STATUSES = ['completed', 'failed', 'timeout', 'user_stopped']
// Told to an ended session when the caller gives no message of their own.
const DEFAULT_CONTINUE_MESSAGE =
	'Please carry on where you left off and finish the work you were doing.'
const RESUME_RUNNING_WAIT_MS = 120_000
const RESUME_RUNNING_POLL_MS = 2_000

/** After resuming a paused session, wait for it to be running before it can take a message. */
async function waitUntilSessionRunning(
	config: McpConfig,
	workspaceId: string | undefined,
	id: string,
): Promise<boolean> {
	const deadline = Date.now() + RESUME_RUNNING_WAIT_MS
	while (Date.now() < deadline) {
		const row = (await apiCall(config, 'GET', `/api/sessions/${id}`, undefined, {
			workspaceId,
		})) as { status: string }
		if (row.status === 'running') return true
		if (ENDED_SESSION_STATUSES.includes(row.status)) return false
		await new Promise((resolve) => setTimeout(resolve, RESUME_RUNNING_POLL_MS))
	}
	return false
}

// A waiting call checks every few seconds until the session ends. There is no time
// limit: the wait ends when the session ends, when it stops moving on its own
// (waiting for input, paused) or when the status checks keep failing. Sessions have
// their own timeout, so none runs forever.
const WAIT_POLL_MS = 5_000

// Short helpers finish quickly, so the first checks stay at WAIT_POLL_MS; a wait that is
// still going backs off so a long one is not ~130 requests against the API.
function waitPollDelayMs(attempt: number): number {
	if (attempt < 6) return WAIT_POLL_MS
	if (attempt < 12) return WAIT_POLL_MS * 2
	return WAIT_POLL_MS * 4
}
// Consecutive failed status checks tolerated before the wait gives up. A blip
// (deploy restart, 502, dropped socket) must not orphan a session that is
// already running.
const MAX_POLL_FAILURES = 5

/**
 * What the caller reads when a handover did not start. A chat agent that only sees a
 * bare API error tends to tell the person it handed the work over anyway.
 */
function sessionNotStartedResult(
	config: McpConfig,
	toolName: 'create_session' | 'create_sub_chat',
	workspaceId: string | undefined,
	err: unknown,
) {
	const reason = err instanceof Error ? err.message : String(err)
	console.error(`${toolName}: could not start the session`, err)
	return {
		_meta: meta(toolName, config, workspaceId),
		isError: true,
		content: [
			{
				type: 'text' as const,
				text: `Not started: ${reason}. Nothing was handed over. Tell the person in the same reply that the handover failed and why. Do not say the work was handed over or is in progress.`,
			},
		],
	}
}

/**
 * Added to a started session so the caller has something real to quote to the person: the
 * link to its chat, never the session id.
 */
function handoffNote(session: { id: string; status?: string }, url?: unknown) {
	const status = session.status ?? 'pending'
	if (typeof url !== 'string' || !url) {
		return `Started: the session is ${status}. Say it is queued if it has not started running yet. Never show the person a session id.`
	}
	return `Started: the session is ${status}. When you tell the person you handed this over, give them this link to its chat as a markdown link: ${url}. Say it is queued if it has not started running yet. Never show the person a session id.`
}

/**
 * The `wait: true` path of `create_session`: start the session, then wait for it to
 * reach a terminal state and return `{ session, logs }`.
 */
async function createSessionAndWait(
	config: McpConfig,
	args: z.infer<typeof tools.create_session.inputSchema>,
	toolName: 'create_session' | 'create_sub_chat' = 'create_session',
) {
	// `notify_on_complete` is no longer a parameter; a caller that still sends it is
	// ignored, and it is never true on this create call (registered below instead).
	const {
		workspace_id,
		wait: _wait,
		notify_on_complete: _ignored,
		...createBody
	} = args as typeof args & { notify_on_complete?: unknown }
	const wsOpts = { workspaceId: workspace_id }

	// 1. Create session. notify_on_complete is sent as false here: this call
	// returns the result inline, so it is only registered (below) if the wait runs
	// out. False, not omitted, because an omitted value defaults on for a helper
	// started from a chat, and the waiting caller would get the result twice.
	let session: { id: string; status: string }
	try {
		session = (await apiCall(
			config,
			'POST',
			'/api/sessions',
			{ ...createBody, notify_on_complete: false },
			wsOpts,
		)) as { id: string; status: string }
	} catch (err) {
		return sessionNotStartedResult(config, toolName, workspace_id, err)
	}

	return waitForSessionResult(config, {
		toolName,
		workspaceId: workspace_id,
		session,
		registerReturn: true,
	})
}

/**
 * Polls a session until it ends (or stops moving) and returns `{ session, logs, settled }`.
 * Shared by every tool that takes `wait`. `registerReturn` is for the one caller that
 * started the session itself: when the wait stops with the session still going, it asks
 * for the session's result to be sent back to that caller later.
 */
async function waitForSessionResult(
	config: McpConfig,
	opts: {
		toolName:
			| 'create_session'
			| 'create_sub_chat'
			| 'get_session'
			| 'resume_session'
			| 'send_session_message'
		workspaceId: string | undefined
		session: { id: string; status: string }
		registerReturn?: boolean
		/** The session was just read, so judge that reading before the first sleep. */
		judgeFirst?: boolean
	},
) {
	const { toolName, workspaceId: workspace_id, session, registerReturn = false } = opts
	const wsOpts = { workspaceId: workspace_id }
	let sessionId = session.id
	const terminalStatuses = ['completed', 'failed', 'timeout', 'user_stopped']
	// §17.6: when a session hits a subscription limit its terminal report
	// carries retried_session_id — the id of the retry the scheduler
	// enqueued. Follow the redirect so a caller waiting here sees the retry's
	// outcome instead of an intermediate "failed", with the same cap (5) the
	// scheduler enforces so a broken chain can't hold the polling loop for the
	// full timeout.
	const MAX_RETRY_FOLLOWS = 5
	let retryFollows = 0

	// 2. Poll until terminal, following retried_session_id redirects
	let current = session as typeof session & { retriedSessionId?: string | null }
	let settled = false
	let stoppedBecause: 'waiting_for_input' | 'paused' | undefined
	let pollFailures = 0
	let pollError: string | undefined
	let pollAttempt = 0
	let judgeNow = opts.judgeFirst ?? false
	while (true) {
		if (!judgeNow) {
			await new Promise((resolve) => setTimeout(resolve, waitPollDelayMs(pollAttempt++)))
			try {
				current = (await apiCall(
					config,
					'GET',
					`/api/sessions/${sessionId}`,
					undefined,
					wsOpts,
				)) as typeof current
				pollFailures = 0
			} catch (err) {
				pollFailures += 1
				pollError = err instanceof Error ? err.message : String(err)
				if (pollFailures >= MAX_POLL_FAILURES) {
					console.error(`${toolName}: gave up polling session ${sessionId}`, err)
					break
				}
				continue
			}
			pollError = undefined
		}
		judgeNow = false
		if (terminalStatuses.includes(current.status)) {
			const retryId = current.retriedSessionId
			if (retryId && retryFollows < MAX_RETRY_FOLLOWS) {
				retryFollows += 1
				sessionId = retryId
				continue
			}
			settled = true
			break
		}
		// A session parked on waiting_for_input, or paused, will not progress until
		// someone acts on it, and with no time limit polling on would never end. Stop
		// early but leave settled false: the session is not finished.
		if (current.status === 'waiting_for_input' || current.status === 'paused') {
			stoppedBecause = current.status
			break
		}
	}

	// The wait ended with the helper still going (it stopped on waiting_for_input or
	// paused, or the status checks kept failing): ask for its result to be sent back
	// later. Never on the settled path, where the caller gets it inline, and only for
	// the caller that started the session.
	// If the helper ended in the gap, the PATCH sends the return itself.
	// The server says what became of it: 'registered' (still running, it will
	// be sent), 'delivered' (already ended, sent now), 'skipped' (already ended,
	// could not be sent, with the reason) or 'failed' (not registered at all).
	let notifyOnComplete:
		| { state: 'registered' | 'delivered' | 'skipped' | 'failed'; reason?: string }
		| undefined
	if (!settled && registerReturn) {
		try {
			const patched = (await apiCall(
				config,
				'PATCH',
				`/api/sessions/${sessionId}`,
				{ notify_on_complete: true },
				wsOpts,
			)) as {
				notify_on_complete?: 'registered' | 'delivered' | 'skipped'
				notify_skip_reason?: string
			}
			notifyOnComplete = {
				state: patched.notify_on_complete ?? 'registered',
				...(patched.notify_skip_reason ? { reason: patched.notify_skip_reason } : {}),
			}
		} catch (err) {
			console.error(`${toolName}: could not register notify_on_complete`, err)
			notifyOnComplete = {
				state: 'failed',
				reason: err instanceof Error ? err.message : String(err),
			}
		}
	}

	// 3. Fetch logs. A failure here must not discard the session outcome.
	let logs: unknown = null
	let logsError: string | undefined
	try {
		logs = await apiCall(
			config,
			'GET',
			`/api/sessions/${sessionId}/logs?limit=500`,
			undefined,
			wsOpts,
		)
	} catch (err) {
		logsError = err instanceof Error ? err.message : String(err)
	}

	const stopMessage =
		stoppedBecause === 'waiting_for_input'
			? `The session is waiting for input and is not finished. It cannot be answered from the MCP surface yet. Answer it in the web app or @mention the agent. Check it with get_session, read the latest output with get_session_logs (newest first, the question is usually at the end), or stop it with stop_session. The logs field in this response is the first 500 lines, oldest first, so it will likely not contain the question.${notifyOnComplete?.state === 'registered' ? ' Its result will come back to you when it finishes.' : ''}`
			: stoppedBecause === 'paused'
				? 'The session is paused and is not finished: it will not progress until it is resumed. Carry on with it using resume_session.'
				: undefined

	const wsId = workspace_id ?? config.defaultWorkspaceId
	const currentWithUrl = wsId
		? addUrl(current as Record<string, unknown>, config, wsId, {
				kind: 'session',
				id: (current as { id?: string }).id ?? sessionId,
				actorId: (current as { actorId?: string }).actorId,
			})
		: current
	// Surface how many retry redirects the poll followed so callers can
	// distinguish a straight-through completion from one that rode the
	// subscription-limit retry chain.
	const currentWithRetryMeta =
		retryFollows > 0
			? { ...(currentWithUrl as Record<string, unknown>), retry_follows: retryFollows }
			: currentWithUrl

	return {
		_meta: meta(toolName, config, workspace_id),
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({
					session: currentWithRetryMeta,
					logs,
					// Lets the caller find the session again, and says whether the result
					// above is final or just where the wait stopped.
					session_id: sessionId,
					settled,
					...(stoppedBecause ? { stopped_because: stoppedBecause, message: stopMessage } : {}),
					...(pollError ? { poll_error: pollError } : {}),
					...(logsError ? { logs_error: logsError } : {}),
					...(notifyOnComplete
						? {
								notify_on_complete: notifyOnComplete.state,
								...(notifyOnComplete.reason
									? { notify_on_complete_reason: notifyOnComplete.reason }
									: {}),
							}
						: {}),
				}),
			},
		],
	}
}

// ─── Chats: agent status and waiting for replies ──────────────────────────

/** A chat's session as the sessions list returns it (verbose rows). */
interface ChatSessionRow {
	id: string
	actorId: string
	status: string
	updatedAt?: string
}

type ChatAgentStatus = 'starting' | 'running' | 'waiting_for_input' | 'paused' | 'not_running'

/**
 * What an agent is doing in a chat, from its session. `running` means it has a live
 * session: it is either working on a turn or ready for the next message. The session
 * does not say which, so read get_chat_activity for the detail.
 */
function chatAgentStatus(status: string | undefined): ChatAgentStatus {
	if (status === 'pending' || status === 'starting' || status === 'snapshotting') return 'starting'
	if (status === 'running') return 'running'
	if (status === 'waiting_for_input') return 'waiting_for_input'
	if (status === 'paused') return 'paused'
	return 'not_running'
}

/** Every session in a chat, newest first. A failed lookup is an empty list, never an error. */
async function fetchChatSessions(
	config: McpConfig,
	workspaceId: string | undefined,
	conversationId: string,
): Promise<ChatSessionRow[]> {
	try {
		const rows = await apiCall(
			config,
			'GET',
			`/api/sessions?conversation_id=${conversationId}&verbose=true&limit=50`,
			undefined,
			{ workspaceId },
		)
		return Array.isArray(rows) ? (rows as ChatSessionRow[]) : []
	} catch {
		return []
	}
}

/** The newest session of each agent. `rows` must already be newest first. */
function latestSessionByActor(rows: ChatSessionRow[]): Map<string, ChatSessionRow> {
	const latest = new Map<string, ChatSessionRow>()
	for (const row of rows) {
		if (row.actorId && !latest.has(row.actorId)) latest.set(row.actorId, row)
	}
	return latest
}

// A chat reply can take a long time, but not forever: a wait that has not been answered by
// then returns what it has, with settled false.
const CHAT_WAIT_MAX_MS = 30 * 60_000
// Polls to let a woken agent's session appear before "it has no live session" counts.
const CHAT_WAIT_GRACE_POLLS = 3
// Consecutive polls with no live session after which an agent is given up on.
const CHAT_WAIT_IDLE_POLLS = 3

interface ChatReplyMessage {
	id: number
	actorId: string
	actorName?: string
	actorType?: string
	content: string
	metadata?: { source?: string } | null
	createdAt?: string
}

/**
 * Holds until each awaited agent has finished its reply to the message at
 * `afterMessageId`. An agent has finished when its closing message for the turn
 * arrives (the one the platform posts at the end of a turn; interim notes do not
 * count), or when it has no live session any more, so a failed run does not hold the
 * caller for the full wait.
 */
async function waitForChatReplies(
	config: McpConfig,
	opts: {
		workspaceId: string | undefined
		conversationId: string
		afterMessageId: number
		awaitedActorIds: string[]
	},
) {
	const wsOpts = { workspaceId: opts.workspaceId }
	const pending = new Set(opts.awaitedActorIds)
	const seen = new Map<number, ChatReplyMessage>()
	const idlePolls = new Map<string, number>()
	const unanswered = new Set<string>()
	const deadline = Date.now() + CHAT_WAIT_MAX_MS
	let attempt = 0
	let pollFailures = 0
	let pollError: string | undefined

	while (pending.size > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, waitPollDelayMs(attempt)))
		attempt += 1
		try {
			const page = (await apiCall(
				config,
				'GET',
				`/api/conversations/${opts.conversationId}/messages?after_id=${opts.afterMessageId}&limit=200`,
				undefined,
				wsOpts,
			)) as { messages?: ChatReplyMessage[] }
			pollFailures = 0
			pollError = undefined
			for (const message of page.messages ?? []) {
				if (!opts.awaitedActorIds.includes(message.actorId)) continue
				seen.set(message.id, message)
				if (message.metadata?.source === 'final_output') pending.delete(message.actorId)
			}
		} catch (err) {
			pollFailures += 1
			pollError = err instanceof Error ? err.message : String(err)
			if (pollFailures >= MAX_POLL_FAILURES) break
			continue
		}
		if (pending.size === 0 || attempt <= CHAT_WAIT_GRACE_POLLS) continue

		const latest = latestSessionByActor(
			await fetchChatSessions(config, opts.workspaceId, opts.conversationId),
		)
		for (const actorId of [...pending]) {
			const live = latest.get(actorId)
			const hasLiveSession =
				!!live && !ENDED_SESSION_STATUSES.includes(live.status) && live.status !== 'paused'
			const idle = hasLiveSession ? 0 : (idlePolls.get(actorId) ?? 0) + 1
			idlePolls.set(actorId, idle)
			if (idle >= CHAT_WAIT_IDLE_POLLS) {
				pending.delete(actorId)
				unanswered.add(actorId)
			}
		}
	}
	for (const actorId of pending) unanswered.add(actorId)

	const replies = [...seen.values()].sort((a, b) => a.id - b.id)
	return {
		settled: unanswered.size === 0,
		replies,
		...(unanswered.size > 0
			? {
					unanswered_actor_ids: [...unanswered],
					message:
						'Some agents did not finish a reply: they have no live session, or the wait ran out. Read the chat with list_conversation_messages, or see what they did with get_chat_activity.',
				}
			: {}),
		...(pollError ? { poll_error: pollError } : {}),
	}
}

/** A participant as the conversation route returns it. */
interface ChatParticipant {
	actorId: string
	actorName: string
	actorType: string
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
						text: JSON.stringify(payload),
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
						text: JSON.stringify(payload),
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
						text: JSON.stringify(payload),
					},
				],
			}
		},
	)
}

const UPDATE_ENTRY_FIELDS =
	'title, content, status, metadata, driver, attach_file_ids, detach_file_ids'

/**
 * True when an update_objects entry asks for at least one write: a field change,
 * or a non-empty attach/detach list. An id on its own, or an id with only empty
 * attach/detach arrays, writes nothing.
 */
function updateEntryHasChange(entry: {
	id: string
	attach_file_ids?: string[]
	detach_file_ids?: string[]
	[key: string]: unknown
}): boolean {
	const { id: _id, attach_file_ids, detach_file_ids, ...fields } = entry
	return (
		Object.values(fields).some((v) => v !== undefined) ||
		Boolean(attach_file_ids?.length) ||
		Boolean(detach_file_ids?.length)
	)
}

/** Extracts a workspace_id from tool args without coupling the wrapper to the schemas. */
function extractWorkspaceId(args: unknown): string | undefined {
	if (!args || typeof args !== 'object') return undefined
	const ws = (args as { workspace_id?: unknown }).workspace_id
	return typeof ws === 'string' ? ws : undefined
}

/**
 * Refuses a write that names a workspace other than the one the agent session
 * is running in. The model's own workspace_id wins over the session's default
 * in every handler, so without this an agent whose key reaches several
 * workspaces can write to any of them by passing the id.
 *
 * Applies only when the call belongs to a session (over HTTP the
 * X-Maskin-Session-Id header, on stdio the container's SESSION_ID) and a
 * default workspace is known, so human-driven use outside a session is
 * untouched. A write is anything not in READ_ONLY_TOOLS, so a new tool is
 * covered until someone marks it read-only; reads keep taking any workspace
 * the key reaches. create_workspace is exempt: it has no session workspace to
 * stay inside. Throws rather than rewriting the id so the model sees its error.
 */
function assertWriteStaysInSessionWorkspace(
	config: McpConfig,
	toolName: string,
	args: unknown,
): void {
	if (READ_ONLY_TOOLS.has(toolName) || toolName === 'create_workspace') return
	const sessionWorkspaceId = config.defaultWorkspaceId
	if (!sessionWorkspaceId) return
	const sessionId =
		config.transport === 'http'
			? config.maskinSessionId
			: (config.maskinSessionId ?? process.env.SESSION_ID)
	if (!sessionId) return
	const requested = extractWorkspaceId(args)
	if (requested === undefined || requested === sessionWorkspaceId) return
	throw new Error(
		`${toolName} was called with workspace_id ${requested}, but this session runs in workspace ${sessionWorkspaceId}. Agents can only write to the workspace they run in. Omit workspace_id or pass ${sessionWorkspaceId}.`,
	)
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
	const isSuccessArray = (arr: unknown[]): boolean =>
		arr.some((entry) => {
			if (!entry || typeof entry !== 'object') return false
			return (entry as { success?: unknown }).success === true
		})

	if (Array.isArray(parsed)) {
		// Per-target aggregation (update_objects-style). The call counts when
		// at least one entry explicitly reports success === true.
		return isSuccessArray(parsed)
	}
	if (parsed && typeof parsed === 'object') {
		const obj = parsed as { success?: unknown; error?: unknown; id?: unknown; results?: unknown }
		if (obj.success === true) return true
		if (obj.success === false) return false
		// update_objects now wraps its per-target array as `{ results, setup }`
		// so the setup block can ride alongside — apply the same aggregation.
		if (Array.isArray(obj.results)) return isSuccessArray(obj.results)
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

export interface HeroCardLink {
	name: string
	url?: string
}

export interface HeroCardObject {
	id: string
	type: string
	title: string | null
	status: string | null
	driver?: HeroCardActor | null
	// Required for every hero card kind except actors — actor rows already
	// carry `status` (role) and `description` (one-liner), so a synthesized
	// "type · role" summary line is redundant and actors omit it.
	contextLine?: string
	badges?: string[]
	url?: string
	/** A draft an integration can deliver: the card shows its text and an Approve button. */
	preview?: ObjectPreview
	// Actor-only: the raw role, independent of `status`'s isSystem/type fallback.
	role?: string | null
	// Full detail fields — populated by get_actor, ignored by list display
	description?: string | null
	systemPrompt?: string | null
	tools?: Record<string, unknown> | null
	llmProvider?: string | null
	llmConfig?: Record<string, unknown> | null
	// get_actor carries id + name pairs; a list_actors row carries names only.
	skills?: Array<{ id: string; name: string }> | string[] | null
	// Full detail fields — populated by list_triggers
	actionPrompt?: string | null
	config?: Record<string, unknown> | null
	// Populated by list_actors — the triggers/loops wired to this actor.
	connectedTriggers?: HeroCardLink[]
	connectedLoops?: HeroCardLink[]
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

/**
 * Max `relationships` and `connected_objects` rows get_objects returns per
 * object. The graph endpoint returns every edge, so a hub object with hundreds
 * of edges produced a 600k+ character result no client could read. Callers
 * page the rest with list_relationships({ object_id }).
 */
export const GET_OBJECTS_EDGE_CAP = 100

/**
 * Cap one graph block at GET_OBJECTS_EDGE_CAP rows. When rows are dropped the
 * second element tells the caller the real total and where to page the rest;
 * it is null when everything fit, so small objects keep their exact shape.
 */
function capGraphBlock(
	rows: unknown,
	block: 'relationships' | 'connected_objects',
	objectId: string,
): [unknown, Record<string, unknown> | null] {
	if (!Array.isArray(rows) || rows.length <= GET_OBJECTS_EDGE_CAP) return [rows, null]
	return [
		rows.slice(0, GET_OBJECTS_EDGE_CAP),
		{
			returned: GET_OBJECTS_EDGE_CAP,
			total: rows.length,
			truncated: true,
			hint: `Showing the first ${GET_OBJECTS_EDGE_CAP} of ${rows.length}. Call list_relationships with object_id ${objectId} to page the rest${block === 'connected_objects' ? ', then get_objects on the endpoint ids you need' : ''}.`,
		},
	]
}

interface RawObject {
	id: string
	type: string
	title?: string | null
	status?: string | null
	driver?: string | null
	createdAt?: string | null
	updatedAt?: string | null
	metadata?: Record<string, unknown> | null
	/** Present when the object is a draft an integration can deliver. */
	preview?: ObjectPreview | null
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
		...(obj.preview ? { preview: obj.preview } : {}),
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
	// A draft to review always gets the card that can approve it.
	if (payload.object.preview) return UI_RESOURCES.heroCard
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

// Response shape of POST /api/actors/:id/workspace-skills/batch.
interface BatchAttachResult {
	workspaceSkillId: string
	success: boolean
	skill?: unknown
	error?: string
}

// Must match the server-side cap in attachSkillsBatchSchema (packages/shared/src/schemas/workspace-skills.ts).
const ATTACH_SKILLS_BATCH_CHUNK_SIZE = 50

// Attaches skillIds to actorId, chunked into batched HTTP calls, and normalizes
// the per-skill outcomes into the flat list shape both create_actor and
// update_actor return under `attached_skills`. Duplicate IDs and chunks over 50
// entries would otherwise 400 the whole request server-side (attachSkillsBatchSchema
// rejects both), so dedupe and chunk here rather than pass them through raw.
async function attachSkillsBatch(
	config: McpConfig,
	actorId: string,
	skillIds: string[],
): Promise<unknown[]> {
	if (skillIds.length === 0) return []
	const uniqueIds = [...new Set(skillIds)]
	const chunks: string[][] = []
	for (let i = 0; i < uniqueIds.length; i += ATTACH_SKILLS_BATCH_CHUNK_SIZE) {
		chunks.push(uniqueIds.slice(i, i + ATTACH_SKILLS_BATCH_CHUNK_SIZE))
	}

	const chunkResults = await Promise.all(
		chunks.map(async (chunk) => {
			try {
				const rows = (await apiCall(
					config,
					'POST',
					`/api/actors/${actorId}/workspace-skills/batch`,
					{ workspaceSkillIds: chunk },
					{ skipWorkspace: true },
				)) as BatchAttachResult[]
				return rows.map((row) =>
					row.success ? row.skill : { skill_id: row.workspaceSkillId, error: row.error },
				)
			} catch (error) {
				console.error('[MCP] attachSkillsBatch chunk failed:', error)
				const message = error instanceof Error ? error.message : String(error)
				return chunk.map((skillId) => ({ skill_id: skillId, error: message }))
			}
		}),
	)

	return chunkResults.flat()
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
	// get_actor returns id + name pairs; the workspace list returns names only.
	skills?: Array<{ id: string; name: string }> | string[] | null
}

// create_actor/update_actor accept a single `llm_config: { provider, ... }`
// param (see actorLlmConfigSchema in tools.ts), but the actors table still
// stores provider and config as two separate columns. These two helpers do
// the translation at the MCP boundary only: split the merged param apart
// before calling the API, then merge the two response columns back together
// so the tool's response mirrors what was sent in.
function splitLlmConfig(llmConfig: Record<string, unknown> | undefined): {
	llm_provider?: string
	llm_config?: Record<string, unknown>
} {
	if (!llmConfig) return {}
	// api_key is intentionally not part of actorLlmConfigSchema (per-agent API key
	// overrides aren't a supported/tested path — only workspace-level credentials
	// are), but the schema's .passthrough() would otherwise let a caller sneak one
	// through anyway. Strip it here so the boundary actually holds.
	const { provider, api_key: _apiKey, ...rest } = llmConfig
	return {
		...(typeof provider === 'string' ? { llm_provider: provider } : {}),
		...(Object.keys(rest).length > 0 ? { llm_config: rest } : {}),
	}
}

function mergeLlmConfig<T extends Record<string, unknown>>(
	actor: T,
): Omit<T, 'llm_provider' | 'llm_config'> & { llm_config?: Record<string, unknown> } {
	const { llm_provider, llm_config, ...rest } = actor as T & {
		llm_provider?: string | null
		llm_config?: Record<string, unknown> | null
	}
	if (llm_provider == null && llm_config == null) {
		return rest as Omit<T, 'llm_provider' | 'llm_config'>
	}
	return {
		...rest,
		llm_config: {
			...(llm_provider != null ? { provider: llm_provider } : {}),
			...(llm_config ?? {}),
		},
	} as Omit<T, 'llm_provider' | 'llm_config'> & { llm_config?: Record<string, unknown> }
}

interface RawWorkspace {
	id: string
	name?: string | null
	role?: string | null
	/** True for the workspace the caller chose as their default in Settings. */
	isDefault?: boolean
	createdAt?: string | null
	updatedAt?: string | null
	onboardingEnabled?: boolean | null
}

/**
 * The default list_workspaces row: the five fields the heroCard renders plus
 * the top-level onboarding flag the workspace-observer-onboarding skill reads
 * (the API row carries it as `onboardingEnabled`), and the default-workspace
 * marker `isDefault`. Always exactly these seven keys, so a missing value is
 * null (false for isDefault) rather than a dropped key.
 */
function slimWorkspaceRow(workspace: RawWorkspace) {
	return {
		id: workspace.id,
		name: workspace.name ?? null,
		role: workspace.role ?? null,
		createdAt: workspace.createdAt ?? null,
		updatedAt: workspace.updatedAt ?? null,
		onboardingEnabled: workspace.onboardingEnabled ?? null,
		isDefault: workspace.isDefault ?? false,
	}
}

function buildActorHeroCardObject(actor: RawActor, includeDetails = false): HeroCardObject {
	const status = actor.isSystem ? 'system' : (actor.role ?? actor.type ?? null)
	const obj: HeroCardObject = {
		id: actor.id,
		type: 'actor',
		title: actor.name ?? null,
		status,
		// Actors don't have a "driver" — that field is for objects (bet/task/
		// insight) owned/driven by an actor. Omitted rather than null so it
		// doesn't show up in the response at all.
		role: actor.role ?? null,
		// The short one-liner is cheap and useful in list view too, unlike the
		// heavier includeDetails-only fields below (system_prompt, tools, etc.),
		// which are reserved for get_actor's full record.
		description: actor.description ?? null,
	}
	if (includeDetails) {
		obj.systemPrompt = actor.system_prompt ?? null
		obj.tools = actor.tools ?? null
		obj.llmProvider = actor.llm_provider ?? null
		obj.llmConfig = actor.llm_config ?? null
		obj.skills = actor.skills ?? null
	}
	return obj
}

/**
 * Settings keys stripped from every workspace row an MCP tool returns.
 *
 * `/api/workspaces` hands back the whole `settings` blob, which carries live
 * provider credentials (`llm_keys`, `custom_llm.api_key`, `claude_oauth`'s
 * encrypted token pair) and billing internals (`billing`'s Stripe customer and
 * subscription ids, plan, spend cap). None of it is actionable for an agent:
 * the schema-shaped settings an agent legitimately reads — statuses, display
 * names, field definitions, relationship types — stay, and `get_workspace_schema`
 * remains the tool for them. So this is pure exposure plus context noise on a
 * tool agents call constantly to resolve a workspace id.
 *
 * `SECRET_KEY_SEGMENTS` is the self-maintaining half: a settings key added
 * later whose name reads as a credential is dropped without anyone remembering
 * to extend the list. The explicit list covers the ones whose names don't say
 * so (`billing`, `claude_oauth`).
 */
const REDACTED_WORKSPACE_SETTINGS_KEYS = ['billing', 'claude_oauth', 'llm_keys'] as const

/**
 * Nested settings objects that may themselves hold a credential. Only these
 * are descended into — the schema containers (`field_definitions`, `statuses`,
 * `custom_extensions`, …) are left whole, so a workspace whose object type or
 * field happens to be named `secret` keeps its schema intact.
 */
const NESTED_REDACTION_TARGETS = ['custom_llm'] as const

/**
 * Whole `_`-delimited segments that mark a key as credential-bearing. Matched
 * segment-wise rather than as a substring so `monkey` doesn't read as `key`.
 */
const SECRET_KEY_SEGMENTS = new Set([
	'key',
	'keys',
	'apikey',
	'token',
	'tokens',
	'secret',
	'secrets',
	'password',
	'passwords',
	'credential',
	'credentials',
])

function isSecretSettingsKey(key: string): boolean {
	return key.split('_').some((segment) => SECRET_KEY_SEGMENTS.has(segment.toLowerCase()))
}

/**
 * Drop credential- and billing-bearing keys from a workspace's `settings`.
 * Returns a copy; the input is not mutated. A workspace row without
 * `settings` passes through untouched.
 */
export function redactWorkspaceSettings<T>(workspace: T): T {
	if (workspace == null || typeof workspace !== 'object') return workspace
	const row = workspace as Record<string, unknown>
	const settings = row.settings
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return workspace
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
		if ((REDACTED_WORKSPACE_SETTINGS_KEYS as readonly string[]).includes(key)) continue
		if (isSecretSettingsKey(key)) continue
		if (
			(NESTED_REDACTION_TARGETS as readonly string[]).includes(key) &&
			value &&
			typeof value === 'object' &&
			!Array.isArray(value)
		) {
			const nested: Record<string, unknown> = {}
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (!isSecretSettingsKey(k)) nested[k] = v
			}
			out[key] = nested
			continue
		}
		out[key] = value
	}
	return { ...row, settings: out } as T
}

function buildWorkspaceContextLine(workspace: RawWorkspace): string {
	const age = ageLabel(workspace.updatedAt ?? workspace.createdAt)
	const parts = ['workspace']
	if (workspace.isDefault) parts.push('default')
	if (age) parts.push(age)
	return parts.join(' · ')
}

function buildWorkspaceHeroCardObject(workspace: RawWorkspace): HeroCardObject {
	return {
		id: workspace.id,
		type: 'workspace',
		title: workspace.name ?? null,
		status: workspace.role ?? 'active',
		// Workspaces don't have a "driver" — that field is for objects (bet/
		// task/insight) owned/driven by an actor. Omitted rather than null so
		// it doesn't show up in the response at all (mirrors actor cards).
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
	hasMore?: boolean,
): Promise<HeroCardPayload> {
	if (!Array.isArray(rows) || rows.length === 0) return { kind: 'empty', tool }
	const driverIds = rows.map((o) => o.driver).filter((v): v is string => typeof v === 'string')
	const actors = await resolveActors(config, driverIds, workspaceId)
	const heroObjects = rows.map((o) =>
		buildHeroCardObject(o, o.driver ? (actors.get(o.driver) ?? null) : null),
	)
	if (heroObjects.length === 1 && totalCount === 1) {
		return { kind: 'single', tool, object: heroObjects[0] }
	}
	const uiObjects = heroObjects.slice(0, HERO_CARD_UI_PAGE_SIZE)
	return {
		kind: 'list',
		tool,
		objects: uiObjects,
		totalCount,
		page: {
			limit: uiObjects.length,
			offset,
			hasMore: hasMore ?? offset + uiObjects.length < totalCount,
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

// Bounds each actor's connected-triggers/loops arrays, so one heavily-wired
// actor doesn't dominate the list. This is a per-actor cap only, not a
// total-response cap — list_actors carries no token-cap trimming (see the
// exclusion comment in response-cap.ts), so a page of many heavily-wired
// actors is still uncapped in aggregate. Deliberately left that way: real
// workspaces don't approach the row/link counts needed to threaten the
// token ceiling, and adding list_actors to response-cap.ts's trimming would
// need its own recovery story (no natural per-row fetch-by-id boundary the
// way list_objects has get_objects).
const MAX_CONNECTED_LINKS_PER_ACTOR = 20

interface ActorLinks {
	triggersByActor: Map<string, HeroCardLink[]>
	loopsByActor: Map<string, HeroCardLink[]>
}

function pushLink(map: Map<string, HeroCardLink[]>, actorId: string, link: HeroCardLink): void {
	const existing = map.get(actorId)
	if (existing) {
		if (existing.length < MAX_CONNECTED_LINKS_PER_ACTOR) existing.push(link)
		return
	}
	map.set(actorId, [link])
}

/**
 * Best-effort lookup of the triggers and loops wired to every actor in a
 * workspace, for `list_actors`' `connectedTriggers`/`connectedLoops` fields.
 * A trigger carries a single `targetActorId` (`packages/db/src/schema.ts`);
 * a loop derives `agentIds` server-side from its member triggers
 * (`apps/dev/src/routes/loops.ts`). Both endpoints return every workspace row
 * when called without a `limit`/`id` filter, so this is two requests total
 * regardless of how many actors are on the current page — not an N+1 over
 * the actors being listed. The two requests run concurrently (no data
 * dependency between them) and each has its own try/catch, so one failing
 * doesn't affect the other and neither failure fails `list_actors` itself
 * (mirrors `resolveActors`) — a triggers/loops outage just degrades to
 * missing links.
 */
async function resolveActorLinks(config: McpConfig, workspaceId: string): Promise<ActorLinks> {
	const [triggersByActor, loopsByActor] = await Promise.all([
		resolveTriggerLinks(config, workspaceId),
		resolveLoopLinks(config, workspaceId),
	])
	return { triggersByActor, loopsByActor }
}

/**
 * Resolve the `wiredToAutomation` input to `checkActor`'s setup check. Only
 * meaningful for agents with a known workspace — returns `undefined`
 * otherwise, which `checkActor` treats as "not wired" (the conservative
 * default). Callers that already have `ActorLinks` on hand for their own
 * output fields (e.g. `get_actor`'s `connectedTriggers`/`connectedLoops`)
 * should read those directly instead of calling this, to avoid a duplicate
 * workspace-wide triggers+loops fetch.
 */
async function resolveWiredToAutomation(
	config: McpConfig,
	wsId: string | undefined,
	actorType: string | null | undefined,
	actorId: string,
): Promise<boolean | undefined> {
	if (actorType !== 'agent' || !wsId) return undefined
	const links = await resolveActorLinks(config, wsId)
	return Boolean(
		links.triggersByActor.get(actorId)?.length || links.loopsByActor.get(actorId)?.length,
	)
}

async function resolveTriggerLinks(
	config: McpConfig,
	workspaceId: string,
): Promise<Map<string, HeroCardLink[]>> {
	const triggersByActor = new Map<string, HeroCardLink[]>()
	const baseUrl = config.webAppBaseUrl ? stripTrailingSlash(config.webAppBaseUrl) : null
	try {
		const rawTriggers = (await apiCall(config, 'GET', '/api/triggers', undefined, {
			workspaceId,
		})) as Array<{ id: string; name?: string | null; targetActorId?: string | null }>
		for (const t of rawTriggers) {
			if (!t.targetActorId) continue
			const name = t.name || `Trigger ${t.id.slice(0, 8)}`
			pushLink(triggersByActor, t.targetActorId, {
				name,
				...(baseUrl
					? { url: buildWebAppHref(baseUrl, workspaceId, { kind: 'trigger', id: t.id }) }
					: {}),
			})
		}
	} catch (err) {
		console.error('[MCP] Failed to resolve connected triggers for list_actors:', err)
	}
	return triggersByActor
}

async function resolveLoopLinks(
	config: McpConfig,
	workspaceId: string,
): Promise<Map<string, HeroCardLink[]>> {
	const loopsByActor = new Map<string, HeroCardLink[]>()
	const baseUrl = config.webAppBaseUrl ? stripTrailingSlash(config.webAppBaseUrl) : null
	try {
		const rawLoops = (await apiCall(config, 'GET', '/api/loops', undefined, {
			workspaceId,
		})) as { loops?: Array<{ id: string; name?: string | null; agentIds?: string[] }> }
		for (const loop of rawLoops.loops ?? []) {
			const name = loop.name || 'Untitled loop'
			for (const agentId of loop.agentIds ?? []) {
				pushLink(loopsByActor, agentId, {
					name,
					...(baseUrl
						? { url: buildWebAppHref(baseUrl, workspaceId, { kind: 'loop', id: loop.id }) }
						: {}),
				})
			}
		}
	} catch (err) {
		console.error('[MCP] Failed to resolve connected loops for list_actors:', err)
	}
	return loopsByActor
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

/**
 * Runtime handler for a registered tool. Same wrapped shape the stdio / HTTP
 * transports get — a plain function that takes the tool's args plus an
 * `extra` bag (typically the request context) and returns the MCP tool
 * response (`{ content, structuredContent?, _meta? }`). Exposed so callers
 * (voice tool-proxy in Task 3, unit tests here) can dispatch tools without
 * standing up a transport.
 */
// biome-ignore lint/suspicious/noExplicitAny: exported for use across transports; concrete arg shape varies per tool.
export type McpToolHandler = (args: unknown, extra?: any) => Promise<any>

// Per-server handler registry, populated by createMcpServer as it registers
// tools. Keyed by the server instance so multiple servers built with
// different configs each get their own map — no cross-config leakage.
const serverHandlers = new WeakMap<McpServer, Map<string, McpToolHandler>>()

/**
 * Retrieve the handler map for a server previously built by `createMcpServer`.
 * Returns an empty map if the server wasn't built here — never undefined, so
 * callers don't need to null-check.
 */
export function getServerHandlers(server: McpServer): Map<string, McpToolHandler> {
	return serverHandlers.get(server) ?? new Map()
}

export function createMcpServer(config: McpConfig) {
	const server = new McpServer({
		name: 'maskin',
		version: '0.1.0',
	})

	// Populated inside the `registerAppTool` wrapper below as each tool is
	// registered — one entry per tool, keyed by the same name the SDK indexes.
	// Attached to the server via `serverHandlers` so `getServerHandlers`
	// (and `createInvokeTool` in ./invoke.ts) can dispatch tools directly.
	const handlers = new Map<string, McpToolHandler>()

	const telemetrySink: TelemetrySink = config.telemetrySink ?? createDefaultSink()
	const telemetryTarget = {
		apiBaseUrl: config.apiBaseUrl,
		apiKey: config.apiKey,
		workspaceId: config.defaultWorkspaceId,
		sessionId: config.telemetrySessionId,
		sessionSource: config.telemetrySessionSource,
		mcpEra: config.telemetryEra,
		mcpProtocolVersion: config.telemetryProtocolVersion,
	}

	// Telemetry-instrumented tool registration. Wraps the upstream
	// `registerAppTool` so every tool response emits a `tool_call` telemetry
	// event (rich-render % numerator/denominator) and successful mutations
	// emit an additional `mutation` event. Read-side handler failures are
	// converted into a structured `{ error: { tool, reason, next } }` response
	// (see `read-error.ts`) so the calling LLM sees a teachable next step
	// instead of a bare transport error; mutation failures still re-throw so
	// their existing error semantics are preserved.
	//
	// We deliberately type as `any` at the boundary because ext-apps' generic
	// tool signature can't be re-introduced through a higher-order wrapper
	// without losing the per-tool input schema inference; the wrapper is purely
	// pass-through so giving up the wrapper's signature is safe.
	// biome-ignore lint/suspicious/noExplicitAny: see comment above.
	const registerAppTool = ((s: any, name: string, baseDefinition: any, handler: any) => {
		// Old parameter spellings are rewritten inside the input schema, because the
		// SDK validates arguments before our handler runs. A tool with no alias
		// rows passes through untouched, so its tools/list entry is unchanged.
		const definition =
			baseDefinition?.inputSchema && needsNormalise(name)
				? {
						...baseDefinition,
						inputSchema: wrapInputSchema(baseDefinition.inputSchema, (raw) => {
							const normalised = normaliseArgs(name, raw)
							// One event per call that used at least one old name. Here, not in
							// the handler, so it fires before validation and a call that then
							// fails validation is still counted. Fire and forget; key names
							// only. A separate event type from tool_call, so the server-side
							// trace is not double counted.
							if (normalised.renames.length > 0) {
								recordAliasUse(telemetrySink, telemetryTarget, {
									tool_name: name,
									workspace_id: extractWorkspaceId(raw),
									renames: normalised.renames,
									both_sent: normalised.bothSent,
									transport: config.transport,
								})
							}
							return normalised.args
						}),
					}
				: baseDefinition
		const defHasRichRender = Boolean(definition?._meta?.ui)
		const mutationKind = MUTATION_TOOL_KINDS[name]
		const isReadTool = READ_TOOL_NAMES.has(name)

		const wrappedHandler = async (args: unknown, extra: unknown) => {
			const start = Date.now()
			let response: unknown
			try {
				assertWriteStaysInSessionWorkspace(config, name, args)
				response = await handler(args, extra)
			} catch (err) {
				recordToolCall(telemetrySink, telemetryTarget, {
					tool_name: name,
					has_rich_render: defHasRichRender,
					duration_ms: Date.now() - start,
					workspace_id: extractWorkspaceId(args),
					args,
					ok: false,
					transport: config.transport,
				})
				if (isReadTool) {
					// Read handlers return a structured error envelope instead of
					// throwing so the caller sees the failing tool, a human-readable
					// reason, and the next tool to try. Mutation tools intentionally
					// keep their throwing behavior — the Guided setup workflow bet
					// owns post-mutation guidance.
					//
					// The envelope sent to the caller is deliberately sanitized, so
					// log the raw error here — this is the only place the original
					// stack trace is still available.
					console.error(`[MCP] Read tool "${name}" failed:`, err)
					const errorResponse = toolErrorResponse(name, err)
					recordToolCallResponseSize(telemetrySink, telemetryTarget, {
						tool_name: name,
						content: errorResponse.content,
						structured_content: errorResponse.structuredContent,
						truncated: false,
						workspace_id: extractWorkspaceId(args),
						// Same position as the `tool_call` event emitted just above,
						// which is what joins the two halves of this call. Read
						// with no `await` in between, so a concurrent call cannot
						// advance the shared counter and mis-pair the two events —
						// keep it that way. Dropped on HTTP, where the paired event
						// is numbered elsewhere (see `recordToolCallResponseSize`).
						seq: currentToolCallSeq(),
						args,
						transport: config.transport,
					})
					return errorResponse
				}
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
				args,
				ok: true,
				transport: config.transport,
			})

			// Read before the cap below: applyResponseTokenCap may hand back a
			// different object, and the symbol only lives on the handler's own.
			const telemetryView = (response as { [TELEMETRY_VIEW]?: ListActorsView } | undefined)?.[
				TELEMETRY_VIEW
			]

			// Token-cap guardrail. Enforces `MAX_RESPONSE_TOKENS` before the
			// telemetry event measures the shipped payload — the size event and
			// the wire response see the same, capped shape.
			const capped = applyResponseTokenCap(name, response)
			const finalResponse = capped.response

			// Response-size baseline for response-size telemetry. Measures the
			// two channels MCP serializes onto the wire — `content`
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
				// Same position as the `tool_call` event emitted just above, so the
				// size of a response and the arguments that produced it are one row
				// after a join on (session_id, seq). Read with no `await` in
				// between, so a concurrent call cannot advance the shared counter
				// and mis-pair the two events — keep it that way. Dropped on HTTP,
				// where the paired event is numbered by a different counter (see
				// `recordToolCallResponseSize`).
				seq: currentToolCallSeq(),
				args,
				transport: config.transport,
				view: telemetryView,
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

		// Stash the wrapped handler so `getServerHandlers(server)` and
		// `createInvokeTool(config)` can dispatch this tool without going
		// through a transport. Same wrapped shape stdio/HTTP get — telemetry,
		// token-cap and mutation classification all apply.
		handlers.set(name, wrappedHandler)

		// Title and annotations come from the table in annotations.ts, so every
		// tool gets them here and nowhere else. Extension tools have no row and
		// pass through unannotated.
		const annotation = TOOL_ANNOTATIONS[name]
		const annotatedDefinition = annotation
			? {
					...definition,
					title: annotation.title,
					annotations: {
						readOnlyHint: annotation.readOnlyHint,
						destructiveHint: annotation.destructiveHint,
						idempotentHint: annotation.idempotentHint,
						openWorldHint: annotation.openWorldHint,
					},
				}
			: definition

		// biome-ignore lint/suspicious/noExplicitAny: handler signature varies by inputSchema presence; the wrapper is a pure pass-through so we forward as-is.
		return _registerAppTool(s, name, annotatedDefinition, wrappedHandler as any)
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

			// activeSessionId/activeSessionCurrentActivity/unread_count/subscriber_count
			// are per-viewer/session bookkeeping fields the API returns on every
			// object row; a just-created object never has them populated
			// meaningfully, so create_objects strips them from the response.
			const enrichedNodes = Array.isArray(graphResult.nodes)
				? graphResult.nodes.map((node) => {
						const {
							activeSessionId,
							activeSessionCurrentActivity,
							unread_count,
							subscriber_count,
							...rest
						} = node as Record<string, unknown>
						return addUrl(rest, config, workspace_id, { kind: 'object', id: node.id })
					})
				: graphResult.nodes
			const enrichedResult = { ...graphResult, nodes: enrichedNodes }
			const baseBody = fileAttachments.length
				? { ...enrichedResult, file_attachments: fileAttachments }
				: enrichedResult

			// No setup block on create — matches create_actor/create_loop: creates
			// stay bare, setup guidance surfaces on update_* and get_* include:['setup'].
			return {
				_meta: meta('create_objects', config, workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(baseBody) }],
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
						return { id, success: true as const, result }
					} catch (error) {
						// Per-id sub-error follows the same `{ error: { tool, reason, next } }`
						// contract as top-level tool errors so callers pattern-match on one
						// shape for both "one id failed in a batch" and "the whole tool
						// failed." Top-level throws (e.g. from resolveActors) are caught by
						// the READ_TOOL_NAMES branch in the registerAppTool wrapper below.
						return { id, success: false as const, ...buildReadErrorBody('get_objects', error) }
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
			// Setup context is fetched once per get_objects call and shared across
			// every object in the batch — one extra API call (the workspace row)
			// regardless of how many ids were requested. Always fetched — `setup`
			// is an always-on block on get_objects, not opt-in. `checkBet` handles
			// arbitrary object types via `statusOrder`; for loops the deeper
			// check-set lives on `get_loop`, which always returns its own richer
			// `setup` block.
			//
			// When the shared fetch throws we capture the error and let
			// `safeBuildSetupBlock` rethrow it per-object so each block collapses
			// to a single `unknown` check — surfacing "no LLM keys" as certain
			// when we actually couldn't check would be a false negative.
			let sharedWorkspaceSettings: Record<string, unknown> | null = null
			let sharedWorkspaceLlmConfigured: { anthropic?: boolean; openai?: boolean } | undefined
			let sharedWorkspaceError: unknown = null
			if (wsId) {
				try {
					const workspace = await getWorkspace(config, wsId)
					sharedWorkspaceSettings = workspace.settings
					sharedWorkspaceLlmConfigured = workspace.llm_configured
				} catch (err) {
					sharedWorkspaceError = err
				}
			}
			// Default projection: strip every graph field except the core seven
			// (`id, type, title, status, contextLine, url, workspaceId`) so the LLM's
			// context isn't paid to carry relationships/connected_objects/events/files/
			// content/metadata the caller didn't ask for. `workspaceId` stays in the
			// core set (unlike the other fields) because it's a small id, not bulky
			// content, and callers/widgets need it to route follow-up requests.
			const projectedResults = await Promise.all(
				results.map(async (r) => {
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
					// A draft an integration can deliver always carries its preview: who it goes to,
					// the subject, the exact text and whether a person approved it. Small, and the
					// reason anyone reads it. Absent for every other object.
					if (withUrl.preview) projectedObject.preview = withUrl.preview
					if (includeSet.has('content') && 'content' in withUrl) {
						projectedObject.content = withUrl.content
					}
					if (includeSet.has('metadata') && 'metadata' in withUrl) {
						projectedObject.metadata = withUrl.metadata
					}
					const extras: Record<string, unknown> = {}
					if (includeSet.has('relationships') && graph && 'relationships' in graph) {
						const [rows, page] = capGraphBlock(
							graph.relationships,
							'relationships',
							withUrl.id as string,
						)
						extras.relationships = rows
						if (page) extras.relationships_page = page
					}
					if (includeSet.has('connected_objects') && graph && 'connected_objects' in graph) {
						const [rows, page] = capGraphBlock(
							graph.connected_objects,
							'connected_objects',
							withUrl.id as string,
						)
						extras.connected_objects = rows
						if (page) extras.connected_objects_page = page
					}
					if (includeSet.has('events') && graph && 'events' in graph) {
						extras.events = graph.events
					}
					if (includeSet.has('files') && graph && 'files' in graph) {
						extras.files = graph.files
					}
					extras.setup = await safeBuildSetupBlock('object_setup', async () => {
						if (sharedWorkspaceError) throw sharedWorkspaceError
						return buildBetSetupBlock(
							{
								id: withUrl.id as string,
								type: withUrl.type as string,
								status: (withUrl.status as string | undefined) ?? null,
								content: (withUrl.content as string | undefined) ?? null,
								driver: (withUrl.driver as string | undefined) ?? null,
							},
							readWorkspaceLlmReadiness(sharedWorkspaceSettings, sharedWorkspaceLlmConfigured),
							readStatusOrder(sharedWorkspaceSettings, withUrl.type as string),
						)
					})
					return { ...r, result: { object: projectedObject, ...extras } }
				}),
			)

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
				content: [{ type: 'text' as const, text: JSON.stringify(projectedResults) }],
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

			// Refuse a call that would write nothing. The schema defaults both lists
			// to [], so a missing list, an empty list and a list sent under the wrong
			// name (the SDK drops unknown keys) all arrive here as []. Throw before
			// any API call so the SDK reports isError and the caller cannot mistake
			// an empty result for a finished write.
			const hasWritableUpdate = args.updates?.some(updateEntryHasChange) ?? false
			if (!hasWritableUpdate && !args.edges?.length) {
				const idleIds = (args.updates ?? []).map((u) => u.id)
				throw new Error(
					`update_objects wrote nothing: ${
						idleIds.length > 0
							? `no entry in updates (${idleIds.join(', ')}) has a field to change`
							: 'it received no updates and no edges'
					}. Expected updates as an array of {id, ...fields to change} (allowed fields: ${UPDATE_ENTRY_FIELDS}; empty attach_file_ids and detach_file_ids lists count as nothing) and/or edges as an array of {source_id, target_id, type}. Send real arrays, not JSON strings, and name the list updates (not objects). Nothing was written.`,
				)
			}

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

						// In a mixed call, an entry with nothing to write is reported, not
						// dropped, so its id never silently vanishes from results.
						if (!updateEntryHasChange({ id, attach_file_ids, detach_file_ids, ...body })) {
							out.push({
								type: 'object',
								id,
								success: false,
								error: `No field to change. Allowed: ${UPDATE_ENTRY_FIELDS}. Empty attach_file_ids and detach_file_ids lists count as nothing.`,
							})
							return out
						}

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

			// Setup block computed from the updated object rows. Every successful
			// object update contributes; edges + file ops don't (they alter
			// relationships, not the object's own state). Workspace-level warns
			// dedupe across updates via mergeBetSetupBlocks.
			const successfulObjectResults = results.filter(
				(r): r is { type: string; id: string; success: true; result: unknown } =>
					r.type === 'object' && r.success === true && r.result != null,
			)
			const perObjectSetup = await Promise.all(
				successfulObjectResults.map((r) => {
					const obj = r.result as {
						id?: string
						type?: string
						status?: string | null
						content?: string | null
						driver?: string | null
					}
					return buildBetSetupBlockFromApi(
						{
							id: obj.id ?? r.id,
							type: obj.type ?? '',
							status: obj.status ?? null,
							content: obj.content ?? null,
							driver: obj.driver ?? null,
						},
						setupApiCaller(config),
						{
							workspaceId: workspace_id,
							defaultWorkspaceId: config.defaultWorkspaceId,
						},
					)
				}),
			)
			const setup = mergeBetSetupBlocks(perObjectSetup)
			const responseBody = { results, setup }

			return {
				_meta: meta('update_objects', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(responseBody) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			// The API's cursor keyset can seek on either `createdAt` (default) or
			// `updatedAt` (when `sort` is set) — both are real timestamp columns
			// with a supporting index, so the cursor walk works uniformly either
			// way. `order` must be pinned from the first call so an `asc` request
			// isn't silently dropped to the pagination default of `desc`.
			const order = args.sort === 'updated_at_asc' ? 'asc' : 'desc'
			const pagination = resolveListPagination({
				limit: args.limit,
				cursor: args.cursor,
				order,
				maxLimit: LIST_ENDPOINT_MAX_LIMIT,
			})
			const params = new URLSearchParams()
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.driver) params.set('driver', args.driver)
			if (args.updated_before) params.set('updated_before', args.updated_before)
			if (args.updated_after) params.set('updated_after', args.updated_after)
			params.set('sort', args.sort ? 'updatedAt' : 'createdAt')
			params.set('order', pagination.order)
			// The `+ 1` sentinel tells us whether more rows follow; at the endpoint cap
			// there is no room for it, so a full page is probed with a one-row call.
			params.set('limit', String(Math.min(pagination.limit + 1, LIST_ENDPOINT_MAX_LIMIT)))
			params.set('snapshot_at', pagination.snapshotAt)
			if (pagination.cursor) {
				params.set('cursor_created_at', pagination.cursor.k.sortValue)
				params.set('cursor_id', pagination.cursor.k.id)
			}
			for (const [field, value] of Object.entries(args.metadata_eq ?? {})) {
				if (typeof value === 'string' && value.length > 0) params.set(`metadata.${field}`, value)
			}
			if (args.include_archived) params.set('include_archived', 'true')
			const apiOptions = { workspaceId: args.workspace_id }
			const sortValueOf = (row: RawObject) => (args.sort ? row.updatedAt : row.createdAt)
			const { data, response } = await apiCallWithResponse(
				config,
				'GET',
				`/api/objects?${params}`,
				undefined,
				apiOptions,
			)
			let raw = data as RawObject[]
			const lastRaw = raw[raw.length - 1]
			const lastSortValue = lastRaw && sortValueOf(lastRaw)
			if (
				pagination.limit === LIST_ENDPOINT_MAX_LIMIT &&
				lastRaw &&
				lastSortValue &&
				raw.length === pagination.limit
			) {
				const probeParams = new URLSearchParams(params)
				probeParams.set('limit', '1')
				probeParams.set('cursor_created_at', lastSortValue)
				probeParams.set('cursor_id', lastRaw.id)
				const probe = (await apiCall(
					config,
					'GET',
					`/api/objects?${probeParams}`,
					undefined,
					apiOptions,
				)) as RawObject[]
				raw = [...raw, ...probe]
			}
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw, sortValueOf)
			const result = trimmed as RawObject[]
			const totalCount = parseTotalCountHeader(response, result.length)
			const heroCard = await buildCollectionHeroCard(
				config,
				'list_objects',
				result,
				args.workspace_id,
				totalCount,
				0,
				nextCursor !== null,
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
						text: buildListContentText(enriched),
					},
				],
				structuredContent: {
					heroCard,
					objects: enriched,
					page: {
						limit: pagination.limit,
						returned: result.length,
						...(nextCursor ? { next_cursor: nextCursor } : {}),
					},
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
				// If the token cap trims this page, the walk resumes after the last row
				// that actually ships instead of after the whole pre-trim page.
				[RESUME_CURSOR]: (lastShipped: unknown) => {
					const row = lastShipped as RawObject
					const sortValue = sortValueOf(row)
					return sortValue
						? encodeCursor({
								s: pagination.snapshotAt,
								o: pagination.order,
								k: { sortValue, id: row.id },
							})
						: null
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
			// The `/api/objects/search` route ranks matches by token-hit count
			// whenever `q` tokenizes to a non-empty set (T2). Under that
			// ORDER BY, the API's `(createdAt, id)` keyset seek no longer
			// matches the walk order, so this tool never accepts a cursor —
			// callers walk multi-page results via `offset` instead. `snapshot_at`
			// still pins every page of a multi-page walk to the same instant so
			// inserts between calls can't shift results across pages.
			const pagination = resolveListPagination({ limit: args.limit, cursor: undefined })
			const params = new URLSearchParams()
			params.set('q', args.q)
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.driver_id) params.set('driver', args.driver_id)
			if (args.updated_after) params.set('updated_after', args.updated_after)
			params.set('limit', String(pagination.limit))
			if (args.offset) params.set('offset', String(args.offset))
			for (const [field, value] of Object.entries(args.metadata_eq ?? {})) {
				if (typeof value === 'string' && value.length > 0) params.set(`metadata.${field}`, value)
			}
			if (args.include_archived) params.set('include_archived', 'true')
			params.set('snapshot_at', pagination.snapshotAt)
			const raw = (await apiCall(config, 'GET', `/api/objects/search?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as RawObject[]
			// Client-side cap — the API already respects `limit`, but keeps the
			// output bounded even if a caller (or a test stub) hands back more.
			const result = raw.slice(0, pagination.limit)
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
						text: buildListContentText(enriched),
					},
				],
				structuredContent: {
					heroCard,
					objects: enriched,
					page: {
						limit: result.length,
						offset,
						returned: result.length,
					},
				},
			}
		},
	)

	// ─── Relationships ────────────────────────────────────────
	registerAppTool(
		server,
		'create_relationship',
		{
			description: tools.create_relationship.description,
			inputSchema: tools.create_relationship.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const workspaceId = args.workspace_id
			// Preflight: resolve each endpoint to `file`, `object`, or `null`
			// (unknown). Any unknown side must 404 — a caller writing an edge to
			// a nonexistent node was almost certainly working from a stale id
			// or hallucinated one, and the read paths can only be tolerant of
			// dangling endpoints because legacy writers exist. New writes go
			// through this strict gate. Files first: mirrors the derive helper's
			// files > objects precedence.
			const resolveKind = async (id: string): Promise<'file' | 'object' | null> => {
				try {
					await apiCall(config, 'GET', `/api/files/${id}`, undefined, { workspaceId })
					return 'file'
				} catch (err) {
					if (parseApiErrorStatus(err) !== 404) throw err
				}
				try {
					await apiCall(config, 'GET', `/api/objects/${id}`, undefined, { workspaceId })
					return 'object'
				} catch (err) {
					if (parseApiErrorStatus(err) !== 404) throw err
				}
				return null
			}
			const [sourceKind, targetKind] = await Promise.all([
				resolveKind(args.source_id),
				resolveKind(args.target_id),
			])
			const unknownIds: string[] = []
			if (!sourceKind) unknownIds.push(args.source_id)
			if (!targetKind) unknownIds.push(args.target_id)
			if (unknownIds.length > 0) {
				throw new Error(
					`API error 404: Unknown endpoint id(s) in this workspace: ${unknownIds.join(
						', ',
					)}. Both source_id and target_id must resolve to an existing object or file — find them via list_objects, search_objects, or list_files first.`,
				)
			}
			// Server derives sourceType/targetType from the ids via T1's helper;
			// the labels we pass here are placeholders satisfying the wire
			// schema and are ignored by the endpoint. Caller-supplied labels
			// were removed from the MCP contract for exactly this reason —
			// there's one authority for endpoint kind, and it is the id.
			const created = (await apiCall(
				config,
				'POST',
				'/api/relationships',
				{
					source_type: sourceKind,
					source_id: args.source_id,
					target_type: targetKind,
					target_id: args.target_id,
					type: args.type,
				},
				{ workspaceId },
			)) as {
				id: string
				sourceId: string
				sourceType: string
				targetId: string
				targetType: string
				type: string
				createdAt?: string | null
				sourceTitle?: string | null
				targetTitle?: string | null
			}
			return {
				_meta: meta('create_relationship', config, workspaceId),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(created),
					},
				],
				structuredContent: { relationship: created },
			}
		},
	)

	registerAppTool(
		server,
		'list_relationships',
		{
			description: tools.list_relationships.description,
			inputSchema: tools.list_relationships.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor })
			const params = new URLSearchParams()
			if (args.object_id) params.set('object_id', args.object_id)
			if (args.source_id) params.set('source_id', args.source_id)
			if (args.target_id) params.set('target_id', args.target_id)
			if (args.type) params.set('type', args.type)
			params.set('limit', String(pagination.limit + 1))
			params.set('snapshot_at', pagination.snapshotAt)
			params.set('order', pagination.order)
			if (pagination.cursor) {
				params.set('cursor_created_at', pagination.cursor.k.sortValue)
				params.set('cursor_id', pagination.cursor.k.id)
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
			return {
				_meta: meta('list_relationships', config, (args as { workspace_id?: string }).workspace_id),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result),
					},
				],
				structuredContent: {
					relationships: result,
					page: {
						limit: result.length,
						returned: result.length,
						...(nextCursor ? { next_cursor: nextCursor } : {}),
					},
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
				// If the token cap trims this page, the walk resumes after the last row
				// that actually ships, even on the final page where no cursor was emitted.
				[RESUME_CURSOR]: (lastShipped: unknown) => {
					const row = lastShipped as (typeof raw)[number]
					return row.createdAt
						? encodeCursor({
								s: pagination.snapshotAt,
								o: pagination.order,
								k: { sortValue: row.createdAt, id: row.id },
							})
						: null
				},
			}
		},
	)

	registerAppTool(
		server,
		'traverse_graph',
		{
			description: tools.traverse_graph.description,
			inputSchema: tools.traverse_graph.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (typeof args.max_depth === 'number') params.set('max_depth', String(args.max_depth))
			if (typeof args.max_nodes === 'number') params.set('max_nodes', String(args.max_nodes))
			if (args.direction) params.set('direction', args.direction)
			if (args.edge_type_allow_list && args.edge_type_allow_list.length > 0) {
				params.set('edge_types', args.edge_type_allow_list.join(','))
			}
			const query = params.toString()
			const result = (await apiCall(
				config,
				'GET',
				`/api/objects/${args.object_id}/graph/traverse${query ? `?${query}` : ''}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)) as {
				nodes: Array<{ id: string; type: string; title: string | null }>
				edges: Array<{ source: string; target: string; type: string }>
				truncated: boolean
				truncated_reason: 'max_nodes' | 'max_depth' | null
			}
			const summaryLines = [
				`nodes: ${result.nodes.length}${result.truncated ? ` (truncated: ${result.truncated_reason})` : ''}`,
				`edges: ${result.edges.length}`,
			]
			return {
				_meta: meta('traverse_graph', config, (args as { workspace_id?: string }).workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `${summaryLines.join('\n')}\n\n${JSON.stringify(result)}`,
					},
				],
				structuredContent: result,
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			const { workspace_id, role, attach_skill_ids, llm_config, ...createBody } = args

			// Mirrors the server-side default in apps/dev/src/routes/actors.ts
			// (`body.auto_create_workspace ?? body.type === 'human'`) so this predicts
			// exactly whether POST /api/actors will mint a workspace on its own. If it
			// won't (agents by default, or auto_create_workspace explicitly false) and
			// no workspace_id/default workspace is available either, the actor would be
			// created with no workspace membership at all — fail fast instead of
			// silently creating an orphaned actor.
			const willAutoCreateWorkspace =
				(createBody as { auto_create_workspace?: boolean }).auto_create_workspace ??
				createBody.type === 'human'
			const resolvedWorkspace = workspace_id ?? config.defaultWorkspaceId
			if (!willAutoCreateWorkspace && !resolvedWorkspace) {
				throw new Error(
					'workspace_id is required to create an agent (unless auto_create_workspace is true) — pass workspace_id so the agent is added to a workspace on creation.',
				)
			}

			// An agent is created by an authenticated caller and born as a member of
			// workspace_id in the same request (the server rejects an agent create with
			// no key). Humans sign up without a key and are added in a second call below.
			const isAgent = createBody.type === 'agent'
			const bornInWorkspace = isAgent && !willAutoCreateWorkspace ? resolvedWorkspace : undefined
			const rawResult = (await apiCall(
				config,
				'POST',
				'/api/actors',
				{
					...createBody,
					...splitLlmConfig(llm_config as Record<string, unknown> | undefined),
					...(bornInWorkspace ? { workspace_id: bornInWorkspace } : {}),
				},
				{ skipAuth: !isAgent, skipWorkspace: true },
			)) as { id: string; [key: string]: unknown }
			const result = mergeLlmConfig(rawResult) as { id: string; [key: string]: unknown }
			// These fields can't be meaningful on a just-created actor: installedLoopId
			// only applies to actors provisioned via a marketplace loop install (a
			// separate flow from create_actor), and agentState/agentStateUpdatedAt
			// describe container session activity, which is always empty on a
			// brand-new actor. Setting undefined (rather than `delete`) is enough —
			// JSON.stringify omits undefined-valued keys, and avoids the delete
			// operator's perf cost per Biome's noDelete rule.
			result.installedLoopId = undefined
			result.agentState = undefined
			result.agentStateUpdatedAt = undefined

			const targetWorkspace = workspace_id ?? config.defaultWorkspaceId
			if (bornInWorkspace) {
				// Already a member (role member) from the create call above.
				;(result as Record<string, unknown>).workspace_id = bornInWorkspace
				;(result as Record<string, unknown>).role = 'member'
			} else if (targetWorkspace && !isAgent && !createBody.auto_create_workspace) {
				// Humans only: a person can't be added by id without accepting, so the
				// workspace invites them by email and they join when they accept.
				try {
					await apiCall(config, 'POST', '/api/invites', {
						workspaceId: targetWorkspace,
						email: createBody.email,
						role: role ?? 'member',
					})
					;(result as Record<string, unknown>).workspace_id = targetWorkspace
					;(result as Record<string, unknown>).invited_role = role ?? 'member'
				} catch (error) {
					;(result as Record<string, unknown>).workspace_membership_error = String(error)
				}
			}

			// Attach skills after the actor exists — routed through attachSkillsBatch(),
			// which chunks into ≤50-id calls, so a bad ID doesn't discard the actor or
			// the skills that did attach.
			const skillIds = attach_skill_ids ?? []
			let attachedSkillCount = 0
			if (skillIds.length > 0 && result.id) {
				if (createBody.auto_create_workspace) {
					// auto_create_workspace mints a brand-new, empty workspace and makes
					// the actor a member of THAT workspace, not of `targetWorkspace` — the
					// requested skills live in some other, pre-existing workspace the actor
					// was never added to, so every attach would fail with "outside the
					// skill's workspace". Skip the call rather than let every id fail —
					// a new workspace never having existing skills is expected, not worth
					// a dedicated explanation in the response.
				} else {
					const attached = await attachSkillsBatch(config, result.id, skillIds)
					result.attached_skills = attached
					attachedSkillCount = attached.filter(
						(entry) => !(entry as { error?: string })?.error,
					).length
					if (attached.some((entry) => (entry as { error?: string })?.error)) {
						result.partial_failure = true
						result.partial_failure_reason =
							'One or more attach_skill_ids failed to attach — see the `error` field on the corresponding entries in attached_skills. The actor itself, and any skills that did attach, are unaffected.'
					}
				}
			}

			// Same setup block update_actor/get_actor return (checkActor short-
			// circuits to `[]` for humans, so this stays a harmless empty block for
			// them). skillCount and wiredToAutomation are known for free here —
			// skills were just attached (or not) above, and nothing could reference
			// this brand-new actor's id before it existed — so this costs zero extra
			// API calls beyond actor creation itself.
			result.setup = await buildActorSetupBlockFromApi(
				{
					id: result.id,
					name: (result.name as string | null | undefined) ?? null,
					type: (createBody.type as string | null | undefined) ?? null,
					systemPrompt: (createBody.system_prompt as string | undefined) ?? null,
					skillCount: attachedSkillCount,
					nonMaskinMcpServerCount: countNonMaskinMcpServers(createBody.tools),
					wiredToAutomation: false,
				},
				setupApiCaller(config),
			)

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
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl) }],
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
			// The snapshot-consistent cursor walk is only implemented by the
			// workspace-scoped branch of `/api/actors` — the cross-workspace
			// branch (no `workspace_id`) runs a two-phase distinct-actor query
			// ordered by `(name, id)` that doesn't honour `snapshot_at`/
			// `cursor_created_at`/`cursor_id` at all. Sending a cursor there
			// would be silently ignored server-side, so a follow-up call using
			// the returned `next_cursor` (with no `offset` to fall back on)
			// would re-fetch the identical first page forever. Fall back to
			// plain offset pagination — matching this tool's pre-cursor
			// behavior — whenever `workspace_id` is omitted.
			//
			// A name filter only exists on the workspace-scoped path, so a call that
			// passes one without a workspace_id falls back to the default workspace
			// instead of silently taking the unfiltered cross-workspace branch.
			if (args.name !== undefined && args.name_prefix !== undefined) {
				return {
					_meta: meta('list_actors', config, args.workspace_id),
					isError: true,
					content: [{ type: 'text' as const, text: 'Pass name or name_prefix, not both' }],
				}
			}
			const nameFilterRequested = args.name !== undefined || args.name_prefix !== undefined
			const scopeWorkspaceId =
				args.workspace_id ??
				(nameFilterRequested ? config.defaultWorkspaceId || undefined : undefined)
			if (nameFilterRequested && !scopeWorkspaceId) {
				return {
					_meta: meta('list_actors', config, args.workspace_id),
					isError: true,
					content: [{ type: 'text' as const, text: 'name and name_prefix need a workspace_id' }],
				}
			}
			const workspaceScoped = Boolean(scopeWorkspaceId)
			const pagination = resolveListPagination({
				limit: args.limit,
				cursor: workspaceScoped ? args.cursor : undefined,
			})
			const offset = typeof args.offset === 'number' ? args.offset : 0
			// We fetch `limit + 1` so the +1 sentinel drives the next-cursor
			// decision without a second query. The API caps `limit` at 100 so the
			// sentinel stays safely inside the ceiling.
			const fetchCap = workspaceScoped ? pagination.limit + 1 : pagination.limit
			const params = new URLSearchParams({ limit: String(fetchCap), offset: String(offset) })
			if (workspaceScoped) {
				// Skill names ride on every workspace-scoped row.
				params.set('include', 'skills')
				if (args.name !== undefined) params.set('name', args.name)
				if (args.name_prefix !== undefined) params.set('name_prefix', args.name_prefix)
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
				scopeWorkspaceId ? { workspaceId: scopeWorkspaceId } : { skipWorkspace: true },
			)
			const rawRows = Array.isArray(data) ? (data as RawActor[]) : []
			// Trim the sentinel + seed next_cursor from the last-visible row's
			// (createdAt, id) tuple. The cross-workspace branch never gets a
			// cursor; still cap at `pagination.limit` client-side so the shipped
			// count matches what the caller asked for even if the API ignored
			// `limit` (belt-and-suspenders — the API respects it in production).
			const { nextCursor, trimmed } = workspaceScoped
				? encodeNextCursor(pagination, rawRows as Array<{ id: string; createdAt?: string | null }>)
				: { nextCursor: null, trimmed: rawRows.slice(0, pagination.limit) }
			const rows = trimmed as RawActor[]
			const trimmedData = Array.isArray(data) ? (data as unknown[]).slice(0, rows.length) : data
			// URLs aren't part of buildActorHeroCardObject's output — they come
			// from addUrl(), which needs a workspace id. Compute them here and
			// fold them into each hero object so structuredContent is the sole
			// carrier of the response (no separate `content` text channel).
			const wsId = scopeWorkspaceId ?? config.defaultWorkspaceId
			const enriched =
				wsId && Array.isArray(trimmedData)
					? (trimmedData as Array<Record<string, unknown>>).map((a) =>
							addUrl(a, config, wsId, { kind: 'actor', id: a.id as string }),
						)
					: trimmedData
			const enrichedRows: Array<Record<string, unknown>> = Array.isArray(enriched)
				? (enriched as Array<Record<string, unknown>>)
				: []
			// Connected triggers/loops are the bulk of a row (about 73% of the
			// bytes), so they only come back when the caller asks for them with
			// `include`. They also only resolve for a single, known workspace —
			// the cross-workspace branch (no workspace_id) lists actors from many
			// workspaces at once, and a trigger/loop belongs to exactly one, so
			// `include` is ignored there.
			const include = parseListActorsInclude(args.include)
			const wantTriggers = workspaceScoped && include.includes('triggers')
			const wantLoops = workspaceScoped && include.includes('loops')
			const actorLinks =
				wantTriggers || wantLoops
					? await resolveActorLinks(config, scopeWorkspaceId as string)
					: null
			const heroObjects = rows.map((a, idx) => {
				let obj = buildActorHeroCardObject(a)
				const url = pickUrl(enrichedRows[idx])
				if (url) obj = { ...obj, url }
				// Names only; the API leaves the key out for humans and for agents with none.
				if (workspaceScoped && Array.isArray(a.skills) && a.skills.length > 0) {
					obj = { ...obj, skills: a.skills as string[] }
				}
				if (actorLinks) {
					const connectedTriggers = wantTriggers ? actorLinks.triggersByActor.get(a.id) : undefined
					const connectedLoops = wantLoops ? actorLinks.loopsByActor.get(a.id) : undefined
					if (connectedTriggers?.length) obj = { ...obj, connectedTriggers }
					if (connectedLoops?.length) obj = { ...obj, connectedLoops }
				}
				return obj
			})
			const view: ListActorsView = wantTriggers || wantLoops ? 'full' : 'slim'
			const totalCount = parseTotalCountHeader(response, heroObjects.length)
			// heroCard.objects carries every row the API returned on this page —
			// `structuredContent` has no separate rich row array for this tool, so
			// trimming here would silently drop rows the caller can't recover
			// (the hero-card widget already caps display client-side, so a
			// larger array only means more data on the wire, not a wider render).
			const heroCard: HeroCardPayload =
				heroObjects.length === 0
					? { kind: 'empty', tool: 'list_actors' }
					: heroObjects.length === 1 && totalCount === 1
						? { kind: 'single', tool: 'list_actors', object: heroObjects[0] }
						: {
								kind: 'list',
								tool: 'list_actors',
								objects: heroObjects,
								totalCount,
								page: {
									limit: heroObjects.length,
									offset,
									hasMore: offset + heroObjects.length < totalCount,
								},
							}
			return {
				// Read by the registerAppTool wrapper for the size event; a symbol
				// never serializes onto the wire.
				[TELEMETRY_VIEW]: view,
				_meta: uiMeta('list_actors', config, scopeWorkspaceId, pickCollectionResourceUri(heroCard)),
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
				// The SDK's CallToolResult type requires `content` because Zod's
				// `Infer` treats a `ZodDefault` field as required on the output side,
				// even though nothing in the SDK's tool-dispatch path (`mcp.js`'s
				// `Promise.resolve(cb(args, extra))`) actually validates the return
				// value against that schema — this handler genuinely omits `content`
				// at runtime (see the `list_actors: flag ... never emits a content
				// channel` tests); this is a static-type artifact only, not a real
				// contract violation.
				// biome-ignore lint/suspicious/noExplicitAny: see comment above.
			} as any
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
			// Forwarding workspace_id as X-Workspace-Id lets the backend join
			// workspace_members and return the actor's role in that workspace
			// (mirrors list_actors' workspace-scoped `role` field, folded into
			// buildActorHeroCardObject's `status`).
			const result = (await apiCall(
				config,
				'GET',
				`/api/actors/${args.id}`,
				undefined,
				args.workspace_id ? { workspaceId: args.workspace_id } : { skipWorkspace: true },
			)) as RawActor
			const workspaceId = args.workspace_id
			const wsId = workspaceId ?? config.defaultWorkspaceId
			// Connected triggers/loops only resolve for a single, known workspace —
			// mirrors list_actors' resolveActorLinks call.
			const actorLinks = wsId ? await resolveActorLinks(config, wsId) : null
			const connectedTriggers = actorLinks?.triggersByActor.get(result.id)
			const connectedLoops = actorLinks?.loopsByActor.get(result.id)
			let heroObject = buildActorHeroCardObject(result, true)
			if (connectedTriggers?.length) heroObject = { ...heroObject, connectedTriggers }
			if (connectedLoops?.length) heroObject = { ...heroObject, connectedLoops }
			let withUrl: Record<string, unknown> = wsId
				? addUrl(result as unknown as Record<string, unknown>, config, wsId, {
						kind: 'actor',
						id: result.id,
					})
				: (result as unknown as Record<string, unknown>)
			if (connectedTriggers?.length) withUrl = { ...withUrl, connectedTriggers }
			if (connectedLoops?.length) withUrl = { ...withUrl, connectedLoops }
			if (wsId) heroObject = { ...heroObject, url: pickUrl(withUrl) }

			// Agents only — checkActor returns [] for humans, and get_actor stays
			// bare for them rather than attaching an empty setup block. skillCount
			// comes straight off this GET's `skills` field, and wiredToAutomation off
			// the `actorLinks` already fetched above for connectedTriggers/
			// connectedLoops — neither needs an extra API call.
			if (result.type === 'agent') {
				const setup = await buildActorSetupBlockFromApi(
					{
						id: result.id,
						name: result.name ?? null,
						type: result.type ?? null,
						systemPrompt: result.system_prompt ?? null,
						skillCount: result.skills?.length ?? 0,
						nonMaskinMcpServerCount: countNonMaskinMcpServers(result.tools),
						wiredToAutomation: Boolean(connectedTriggers?.length || connectedLoops?.length),
					},
					setupApiCaller(config),
				)
				withUrl = { ...withUrl, setup }
				// What this agent can use: the same description the Integrations, Keychain and agent
				// pages and its launch prompt read, so it cannot differ from any of them.
				if (wsId) {
					try {
						const access = await apiCall(
							config,
							'GET',
							`/api/actors/${result.id}/access`,
							undefined,
							{
								workspaceId: wsId,
							},
						)
						withUrl = { ...withUrl, access }
					} catch {
						// Not every caller may see it; the rest of the actor is still worth returning.
					}
				}
			}

			const heroCard: HeroCardPayload = {
				kind: 'single',
				tool: 'get_actor',
				object: heroObject,
			}
			// `actor` carries the full record alongside the presentation card, so
			// both channels describe the same thing. Without it `structuredContent`
			// held only the heroCard — a lossy, camelCased re-projection missing
			// `setup` and the snake_case fields the tool description promises —
			// while the record lived solely in `content`. A caller comparing the
			// two saw a response that had visibly lost fields, which reads as a
			// truncated or degraded result rather than a card plus its source.
			// Mirrors list_workspaces' `{ heroCard, workspaces }` shape.
			return {
				_meta: uiMeta('get_actor', config, workspaceId, UI_RESOURCES.heroCard),
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl) }],
				structuredContent: { heroCard, actor: withUrl },
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
			const { id, attach_skill_ids, detach_skill_ids, workspace_id, role, llm_config, ...body } =
				args
			const attachIds = attach_skill_ids ?? []
			const detachIds = detach_skill_ids ?? []
			const hasSkillOps = attachIds.length > 0 || detachIds.length > 0

			const overlapping = attachIds.filter((sid) => detachIds.includes(sid))
			if (overlapping.length > 0) {
				throw new Error(
					`Skill IDs appear in both attach_skill_ids and detach_skill_ids: ${overlapping.join(', ')}`,
				)
			}

			// Run actor PATCH first so a failure here throws before any skill/membership ops fire.
			const rawActor = await apiCall(
				config,
				'PATCH',
				`/api/actors/${id}`,
				{ ...body, ...splitLlmConfig(llm_config as Record<string, unknown> | undefined) },
				{ skipWorkspace: true },
			)
			const actor = mergeLlmConfig(rawActor as Record<string, unknown>)

			// Optionally add the actor to a workspace, mirroring create_actor's
			// pattern — a membership failure is reported inline rather than thrown,
			// so a bad workspace_id doesn't discard an otherwise-successful update.
			let membershipError: string | undefined
			if (workspace_id) {
				try {
					await apiCall(
						config,
						'POST',
						`/api/workspaces/${workspace_id}/members`,
						{ actor_id: id, role },
						{ skipWorkspace: true },
					)
					;(actor as Record<string, unknown>).workspace_id = workspace_id
					;(actor as Record<string, unknown>).role = role
				} catch (error) {
					membershipError = String(error)
					;(actor as Record<string, unknown>).workspace_membership_error = membershipError
				}
			}

			if (!hasSkillOps) {
				const wsId = workspace_id ?? config.defaultWorkspaceId
				const actorId = (actor as { id?: string }).id ?? id
				const actorType = (actor as { type?: string | null }).type ?? null
				const withUrl = wsId
					? addUrl(actor as Record<string, unknown>, config, wsId, { kind: 'actor', id: actorId })
					: actor
				const setup = await buildActorSetupBlockFromApi(
					{
						id: actorId,
						name: (actor as { name?: string | null }).name ?? null,
						type: actorType,
						systemPrompt: (actor as { system_prompt?: string | null }).system_prompt ?? null,
						nonMaskinMcpServerCount: countNonMaskinMcpServers((actor as { tools?: unknown }).tools),
						wiredToAutomation: await resolveWiredToAutomation(config, wsId, actorType, actorId),
					},
					setupApiCaller(config),
				)
				const responseBody = { ...(withUrl as Record<string, unknown>), setup }
				return {
					_meta: meta('update_actor', config, workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(responseBody) }],
				}
			}

			// Attach runs through attachSkillsBatch() (chunked into ≤50-id calls); detach
			// has no batch endpoint yet so it stays per-skill with allSettled — either way
			// a single failure doesn't discard the results of operations that already
			// succeeded.
			const [attachEntries, detachSettled] = await Promise.all([
				attachSkillsBatch(config, id, attachIds),
				Promise.allSettled(
					detachIds.map((skillId) =>
						apiCall(config, 'DELETE', `/api/actors/${id}/workspace-skills/${skillId}`, undefined, {
							skipWorkspace: true,
						}),
					),
				),
			])

			const toDetachEntry = (s: PromiseSettledResult<unknown>, skillId: string) =>
				s.status === 'fulfilled'
					? { skill_id: skillId, deleted: true }
					: {
							skill_id: skillId,
							error: s.reason instanceof Error ? s.reason.message : String(s.reason),
						}

			const wsId2 = workspace_id ?? config.defaultWorkspaceId
			const actorId = (actor as { id?: string }).id ?? id
			const actorType = (actor as { type?: string | null }).type ?? null
			const actorWithUrl = wsId2
				? addUrl(actor as Record<string, unknown>, config, wsId2, { kind: 'actor', id: actorId })
				: actor
			const output: Record<string, unknown> = { actor: actorWithUrl }
			if (attachIds.length) {
				output.attached_skills = attachEntries
			}
			if (detachIds.length) {
				output.detached_skills = detachSettled.map((s, i) =>
					// biome-ignore lint/style/noNonNullAssertion: index matches detachIds
					toDetachEntry(s, detachIds[i]!),
				)
			}
			if (
				attachEntries.some((entry) => (entry as { error?: string })?.error) ||
				detachSettled.some((s) => s.status === 'rejected') ||
				membershipError
			) {
				output.partial_failure = true
			}

			output.setup = await buildActorSetupBlockFromApi(
				{
					id: actorId,
					name: (actor as { name?: string | null }).name ?? null,
					type: actorType,
					systemPrompt: (actor as { system_prompt?: string | null }).system_prompt ?? null,
					nonMaskinMcpServerCount: countNonMaskinMcpServers((actor as { tools?: unknown }).tools),
					wiredToAutomation: await resolveWiredToAutomation(config, wsId2, actorType, actorId),
				},
				setupApiCaller(config),
			)

			return {
				_meta: meta('update_actor', config, workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(output) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(redactWorkspaceSettings(result)) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(redactWorkspaceSettings(result)) }],
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
		async (args) => {
			const pagination = resolveListPagination({
				limit: (args as { limit?: number }).limit,
				cursor: (args as { cursor?: string }).cursor,
			})
			const result = await apiCall(config, 'GET', '/api/workspaces', undefined, {
				skipWorkspace: true,
			})
			const rows = Array.isArray(result) ? (result as RawWorkspace[]) : []
			const { page: pagedRows, nextCursor } = paginateClientSide<RawWorkspace>({
				rows,
				limit: pagination.limit,
				snapshotAt: pagination.snapshotAt,
				order: pagination.order,
				cursor: pagination.cursor,
				getSortValue: (row) => row.createdAt ?? null,
				getId: (row) => row.id,
			})
			const safeRows = (args as { include_settings?: boolean }).include_settings
				? pagedRows.map(redactWorkspaceSettings)
				: pagedRows.map(slimWorkspaceRow)
			const heroObjects = pagedRows.map(buildWorkspaceHeroCardObject)
			const webContextWorkspaceId = config.defaultWorkspaceId ?? pagedRows[0]?.id
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
			const payload = buildListPayload({
				key: 'workspaces',
				rows: safeRows,
				limit: pagination.limit,
				nextCursor,
				total: rows.length,
			})
			return {
				_meta: uiMeta('list_workspaces', config, webContextWorkspaceId, UI_RESOURCES.heroCard),
				content: [{ type: 'text' as const, text: listText(payload) }],
				// The card is presentation only; every datum is in the payload the text carries too.
				structuredContent: { heroCard, ...payload },
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
			// Only fall back to the first workspace when no id was asked for at all. An
			// id that is not in the list must fail, not hand back another workspace's schema.
			const workspace = effectiveWsId
				? workspaces.find((w) => w.id === effectiveWsId)
				: workspaces[0]
			if (!workspace) {
				throw new Error(
					effectiveWsId
						? `Workspace ${effectiveWsId} not found. Call list_workspaces to see the workspaces this key can access.`
						: 'No workspace found',
				)
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
				content: [{ type: 'text' as const, text: JSON.stringify(schema) }],
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
						text: JSON.stringify({ workspace_id: wsId, type: args.type, field: created }),
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
				const hasValueOps =
					(args.add_values?.length ?? 0) > 0 || (args.remove_values?.length ?? 0) > 0
				if (nextType !== 'enum' && hasValueOps) {
					throw new Error(`Field "${existing.name}" is type "${nextType}", not "enum".`)
				}
				let nextValues: string[] | undefined
				if (nextType === 'enum') {
					nextValues = args.values ?? existing.values ?? []
					if (args.add_values) {
						for (const value of args.add_values) {
							if (!nextValues.includes(value)) nextValues.push(value)
						}
					}
					if (args.remove_values && args.remove_values.length > 0) {
						const toRemove = new Set(args.remove_values)
						nextValues = nextValues.filter((v) => !toRemove.has(v))
					}
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
						text: JSON.stringify({ workspace_id: wsId, type: args.type, field: updated }),
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
			const pagination = resolveListPagination({
				limit: args.limit,
				cursor: args.cursor,
				maxLimit: LIST_ENDPOINT_MAX_LIMIT,
			})
			const params = new URLSearchParams()
			// The `+ 1` sentinel tells us whether more rows follow; at the endpoint cap
			// there is no room for it, so a full page is probed with a one-row call.
			params.set('limit', String(Math.min(pagination.limit + 1, LIST_ENDPOINT_MAX_LIMIT)))
			params.set('snapshot_at', pagination.snapshotAt)
			params.set('order', pagination.order)
			if (pagination.cursor) {
				params.set('cursor_created_at', pagination.cursor.k.sortValue)
				params.set('cursor_id', pagination.cursor.k.id)
			}
			const skillsPath = `/api/workspaces/${wsId}/skills`
			type SkillListRow = {
				id: string
				name: string
				description?: string | null
				isValid?: boolean
				createdAt?: string | null
			}
			let raw = (await apiCall(config, 'GET', `${skillsPath}?${params}`, undefined, {
				workspaceId: wsId,
			})) as SkillListRow[]
			const lastRaw = raw[raw.length - 1]
			if (
				pagination.limit === LIST_ENDPOINT_MAX_LIMIT &&
				lastRaw?.createdAt &&
				raw.length === pagination.limit
			) {
				const probeParams = new URLSearchParams(params)
				probeParams.set('limit', '1')
				probeParams.set('cursor_created_at', lastRaw.createdAt)
				probeParams.set('cursor_id', lastRaw.id)
				const probe = (await apiCall(config, 'GET', `${skillsPath}?${probeParams}`, undefined, {
					workspaceId: wsId,
				})) as SkillListRow[]
				raw = [...raw, ...probe]
			}
			const { nextCursor, trimmed } = encodeNextCursor(pagination, raw)
			const result = trimmed as SkillListRow[]
			return {
				_meta: meta(
					'list_workspace_skills',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result),
					},
				],
				structuredContent: {
					skills: result,
					page: {
						limit: pagination.limit,
						returned: result.length,
						...(nextCursor ? { next_cursor: nextCursor } : {}),
					},
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
				// If the token cap trims this page, the walk resumes after the last row
				// that actually ships instead of ending at the pre-trim page.
				[RESUME_CURSOR]: (lastShipped: unknown) => {
					const row = lastShipped as SkillListRow
					return row.createdAt
						? encodeCursor({
								s: pagination.snapshotAt,
								o: pagination.order,
								k: { sortValue: row.createdAt, id: row.id },
							})
						: null
				},
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
					...(args.kind !== undefined ? { kind: args.kind } : {}),
					mime_type: args.mime_type,
					content: args.content,
					...(args.encoding !== undefined ? { encoding: args.encoding } : {}),
				},
				{ workspaceId: wsId },
			)
			return {
				_meta: meta('create_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor })
			const params = new URLSearchParams()
			if (args.q) params.set('q', args.q)
			if (args.kind) params.set('kind', args.kind)
			params.set('limit', String(pagination.limit + 1))
			params.set('snapshot_at', pagination.snapshotAt)
			params.set('order', pagination.order)
			if (pagination.cursor) {
				params.set('cursor_created_at', pagination.cursor.k.sortValue)
				params.set('cursor_id', pagination.cursor.k.id)
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
			return {
				_meta: meta('list_files', config, (args as { workspace_id?: string }).workspace_id),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result),
					},
				],
				structuredContent: {
					files: result,
					page: {
						limit: result.length,
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
			const file = result as { mimeType?: string | null; encoding?: string; content?: unknown }
			// Images go back as a real image block so the model can see them; the
			// base64 bytes would otherwise arrive as ~50k chars of opaque text.
			if (
				file?.mimeType?.startsWith('image/') &&
				file.encoding === 'base64' &&
				typeof file.content === 'string'
			) {
				const { content: data, ...metadata } = result as Record<string, unknown> & {
					content: string
				}
				return {
					_meta: meta('get_file', config, (args as { workspace_id?: string }).workspace_id),
					content: [
						{ type: 'text' as const, text: JSON.stringify(metadata) },
						{ type: 'image' as const, data, mimeType: file.mimeType },
					],
				}
			}
			return {
				_meta: meta('get_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			if (args.kind !== undefined) body.kind = args.kind
			if (args.mime_type !== undefined) body.mime_type = args.mime_type
			if (args.content !== undefined) body.content = args.content
			if (args.encoding !== undefined) body.encoding = args.encoding
			if (args.if_match !== undefined) body.if_match = args.if_match
			const result = await apiCall(config, 'PATCH', `/api/files/${args.id}`, body, {
				workspaceId: wsId,
			})
			return {
				_meta: meta('update_file', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			const pagination = resolveListPagination({
				limit: args.limit,
				cursor: (args as { cursor?: string }).cursor,
			})
			const params = new URLSearchParams()
			if (args.id) params.set('id', String(args.id))
			if (args.entity_type) params.set('entity_type', args.entity_type)
			if (args.action) params.set('action', args.action)
			const { page: pagedRows, nextCursor } = await fetchEventHistoryPage(
				config,
				params,
				pagination,
				args.workspace_id,
			)
			return {
				_meta: meta('get_events', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(pagedRows) }],
				structuredContent: {
					events: pagedRows,
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
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
			const pagination = resolveListPagination({
				limit: args.limit,
				cursor: (args as { cursor?: string }).cursor,
			})
			const params = new URLSearchParams()
			params.set('entity_type', 'object')
			params.set('entity_id', args.entity_id)
			params.set('action', 'commented')
			const { page: pagedRows, nextCursor } = await fetchEventHistoryPage(
				config,
				params,
				pagination,
				args.workspace_id,
			)
			return {
				_meta: meta('get_comments', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(pagedRows) }],
				structuredContent: {
					comments: pagedRows,
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
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
			const { workspace_id, no_thread, ...body } = args as {
				workspace_id?: string
				no_thread?: boolean
				parent_event_id?: number
				[key: string]: unknown
			}
			// Thread defaulting: when the session was dispatched from a comment
			// (config.triggeringEventId set by routes/mcp.ts) and the caller
			// didn't already pick a parent, reply inside the triggering thread
			// by default. `no_thread: true` is the explicit opt-out for cases
			// where a fresh top-level comment is actually intended (a status
			// update on a bet, opening a new topic, etc.). This turns the
			// "reply in-thread" guarantee from a per-agent prompt rule (PR
			// #1709) into a tool-level default covering every agent and
			// dispatch path.
			if (
				body.parent_event_id === undefined &&
				no_thread !== true &&
				typeof config.triggeringEventId === 'number'
			) {
				body.parent_event_id = config.triggeringEventId
			}
			const result = await apiCall(config, 'POST', '/api/events', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta('create_comment', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	// ─── Conversations ────────────────────────────────────────
	registerAppTool(
		server,
		'get_conversation',
		{
			description: tools.get_conversation.description,
			inputSchema: tools.get_conversation.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(
				config,
				'GET',
				`/api/conversations/${args.conversation_id}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)) as { participants?: Array<ChatParticipant & { status?: ChatAgentStatus }> }
			// Say who is busy, so an agent does not @mention one that is not running.
			if (Array.isArray(result.participants)) {
				const latest = latestSessionByActor(
					await fetchChatSessions(config, args.workspace_id, args.conversation_id),
				)
				for (const p of result.participants) {
					if (p.actorType === 'agent') p.status = chatAgentStatus(latest.get(p.actorId)?.status)
				}
			}
			return {
				_meta: meta('get_conversation', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_chats',
		{
			description: tools.list_chats.description,
			inputSchema: tools.list_chats.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const pagination = resolveListPagination({
				limit: args.limit,
				cursor: args.cursor,
				maxLimit: LIST_ENDPOINT_MAX_LIMIT,
			})
			// The route pages by offset, so the position travels in the cursor as n.
			const offset = pagination.cursor?.n ?? 0
			const params = new URLSearchParams()
			params.set('sort', 'activity')
			params.set('limit', String(pagination.limit))
			params.set('offset', String(offset))
			if (args.updated_after) params.set('updated_after', args.updated_after)
			if (args.has_human) params.set('has_human', 'true')
			if (args.subject_type && args.subject_id) {
				params.set('subject_type', args.subject_type)
				params.set('subject_id', args.subject_id)
			}
			const raw = (await apiCall(config, 'GET', `/api/conversations?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as {
				conversations: Array<{
					id: string
					title: string
					lastMessageAt: string | null
					unread_count: number
					snippet: string | null
					snippet_actor_id: string | null
					snippet_actor_name: string | null
					snippet_is_caller: boolean
					participants: Array<{ actorName: string; actorType: string }>
				}>
				has_more: boolean
			}
			const chats = raw.conversations.map((c) => ({
				id: c.id,
				title: c.title,
				participants: c.participants.map((p) => ({ name: p.actorName, type: p.actorType })),
				last_message_at: c.lastMessageAt,
				last_message: c.snippet_actor_id
					? {
							from: c.snippet_actor_name,
							is_you: c.snippet_is_caller,
							snippet: truncateSnippet(c.snippet),
						}
					: null,
				unread_count: c.unread_count,
			}))
			const last = raw.conversations[raw.conversations.length - 1]
			const nextOffset = offset + chats.length
			const nextCursor =
				raw.has_more && last?.lastMessageAt && nextOffset <= CURSOR_MAX_OFFSET
					? encodeCursor({
							s: pagination.snapshotAt,
							o: pagination.order,
							k: { sortValue: last.lastMessageAt, id: last.id },
							n: nextOffset,
						})
					: null
			return {
				_meta: meta('list_chats', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(chats) }],
				structuredContent: {
					chats,
					...(nextCursor ? { next_cursor: nextCursor } : {}),
				},
			}
		},
	)

	registerAppTool(
		server,
		'list_conversation_messages',
		{
			description: tools.list_conversation_messages.description,
			inputSchema: tools.list_conversation_messages.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.before_id) params.set('before_id', String(args.before_id))
			if (args.after_id) params.set('after_id', String(args.after_id))
			if (args.thread_root_id) params.set('thread_root_id', String(args.thread_root_id))
			params.set('limit', String(args.limit))
			const result = await apiCall(
				config,
				'GET',
				`/api/conversations/${args.conversation_id}/messages?${params}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta(
					'list_conversation_messages',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'post_conversation_message',
		{
			description: tools.post_conversation_message.description,
			inputSchema: tools.post_conversation_message.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, conversation_id, mention_names, wait, sub_chat_session_id, ...body } =
				args
			rejectCardMetadata(body.metadata)
			// Names are friendlier than UUIDs, and a mistyped UUID silently mentions
			// nobody. Resolve against the live participant list and report misses.
			let unresolvedMentions: MentionNameResolution['unresolved'] = []
			if (mention_names?.length) {
				const conversation = (await apiCall(
					config,
					'GET',
					`/api/conversations/${conversation_id}`,
					undefined,
					{ workspaceId: workspace_id },
				)) as { participants?: MentionParticipant[] }
				const { resolved, unresolved } = resolveMentionNames(
					mention_names,
					conversation.participants ?? [],
				)
				unresolvedMentions = unresolved
				if (resolved.length > 0) {
					const mentions = Array.from(new Set([...(body.metadata?.mentions ?? []), ...resolved]))
					body.metadata = { ...body.metadata, mentions }
				}
			}
			// SESSION_ID is injected by session-manager into every agent
			// container's env — stamping it here lets the conversations route
			// attribute this message back to the session that produced it
			// (messages.session_id), for cost/token drill-down. Over HTTP the
			// server runs inside apps/dev, so that env is the host process's;
			// config.maskinSessionId carries the caller's id and wins. Undefined
			// outside an agent session (e.g. a human testing the MCP server
			// locally), in which case the field is simply omitted.
			// A sub-chat hangs from a message of this chat. Replying in that message's thread is
			// what sends the words to its agent, so the message is looked up from the sub-chat.
			let threadRootId = body.thread_root_id
			if (sub_chat_session_id && threadRootId === undefined) {
				const subChat = (await apiCall(
					config,
					'GET',
					`/api/sessions/${sub_chat_session_id}`,
					undefined,
					{ workspaceId: workspace_id },
				)) as { spawnedByMessageId?: number | null }
				if (typeof subChat.spawnedByMessageId !== 'number') {
					throw new Error(
						`Sub-chat ${sub_chat_session_id} is not attached to a message in a chat yet, so there is no thread to reply in. Talk to it with send_session_message instead.`,
					)
				}
				threadRootId = subChat.spawnedByMessageId
			}
			const result = await apiCall(
				config,
				'POST',
				`/api/conversations/${conversation_id}/messages`,
				{
					...body,
					thread_root_id: threadRootId,
					session_id: config.maskinSessionId ?? process.env.SESSION_ID,
				},
				{ workspaceId: workspace_id },
			)
			const withMentionReport =
				unresolvedMentions.length > 0
					? { ...(result as Record<string, unknown>), unresolved_mentions: unresolvedMentions }
					: result

			// Hold for the answer: the agents @mentioned, or every other agent in the chat.
			let waited: Awaited<ReturnType<typeof waitForChatReplies>> | { note: string } | undefined
			const posted = result as { id?: number; actorId?: string }
			if (wait && typeof posted.id === 'number') {
				// Read after posting: an @mentioned agent has joined the chat by now.
				const conversation = (await apiCall(
					config,
					'GET',
					`/api/conversations/${conversation_id}`,
					undefined,
					{ workspaceId: workspace_id },
				)) as { participants?: ChatParticipant[] }
				const mentioned = new Set(body.metadata?.mentions ?? [])
				const agents = (conversation.participants ?? []).filter(
					(p) => p.actorType === 'agent' && p.actorId !== posted.actorId,
				)
				const awaited = (
					mentioned.size > 0 ? agents.filter((p) => mentioned.has(p.actorId)) : agents
				).map((p) => p.actorId)
				waited =
					awaited.length > 0
						? await waitForChatReplies(config, {
								workspaceId: workspace_id,
								conversationId: conversation_id,
								afterMessageId: posted.id,
								awaitedActorIds: awaited,
							})
						: { note: 'There is no agent in this chat to wait for, so nothing was waited on.' }
			}
			return {
				_meta: meta(
					'post_conversation_message',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							waited
								? { ...(withMentionReport as Record<string, unknown>), wait: waited }
								: withMentionReport,
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
		'create_chat',
		{
			description: tools.create_chat.description,
			inputSchema: tools.create_chat.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const {
				workspace_id,
				title,
				participant_actor_ids,
				first_message,
				subject_type,
				subject_id,
				topical,
				wait,
			} = args
			if ((subject_type === undefined) !== (subject_id === undefined)) {
				throw new Error('subject_type and subject_id go together: give both or neither.')
			}
			// One other actor and no subject is the direct message with them, unless a
			// separate topical chat was asked for. The API gets or creates it.
			const direct = participant_actor_ids.length === 1 && subject_id === undefined && !topical
			const wsOpts = { workspaceId: workspace_id }
			const conversation = (await apiCall(
				config,
				'POST',
				'/api/conversations',
				{
					title,
					participant_actor_ids,
					...(direct ? { direct: true } : {}),
					...(subject_type && subject_id
						? { subject: { type: subject_type, id: subject_id } }
						: {}),
				},
				wsOpts,
			)) as { id: string; participants?: ChatParticipant[] }

			// The first message is its own call, so the agents can be @mentioned by id: the
			// mention is what wakes them, and the create call does not know who is an agent.
			let firstMessage: unknown
			let waitResult: Awaited<ReturnType<typeof waitForChatReplies>> | undefined
			if (first_message) {
				const requested = new Set(participant_actor_ids)
				const agentIds = (conversation.participants ?? [])
					.filter((p) => p.actorType === 'agent' && requested.has(p.actorId))
					.map((p) => p.actorId)
				firstMessage = await apiCall(
					config,
					'POST',
					`/api/conversations/${conversation.id}/messages`,
					{
						content: first_message,
						...(agentIds.length > 0 ? { metadata: { mentions: agentIds } } : {}),
						session_id: config.maskinSessionId ?? process.env.SESSION_ID,
					},
					wsOpts,
				)
				const posted = firstMessage as { id?: number; actorId?: string }
				if (wait && typeof posted.id === 'number') {
					waitResult = await waitForChatReplies(config, {
						workspaceId: workspace_id,
						conversationId: conversation.id,
						afterMessageId: posted.id,
						awaitedActorIds: agentIds.filter((id) => id !== posted.actorId),
					})
				}
			}
			return {
				_meta: meta('create_chat', config, workspace_id),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({
							conversation,
							...(firstMessage ? { first_message: firstMessage } : {}),
							...(waitResult ? { wait: waitResult } : {}),
						}),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'add_chat_participant',
		{
			description: tools.add_chat_participant.description,
			inputSchema: tools.add_chat_participant.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const participants = await apiCall(
				config,
				'POST',
				`/api/conversations/${args.conversation_id}/participants`,
				{ actor_ids: args.actor_ids },
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta('add_chat_participant', config, args.workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify({ participants }) }],
			}
		},
	)

	registerAppTool(
		server,
		'remove_chat_participant',
		{
			description: tools.remove_chat_participant.description,
			inputSchema: tools.remove_chat_participant.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			// The route answers 204 with no body, so there is nothing to parse.
			await apiFetch(
				config,
				'DELETE',
				`/api/conversations/${args.conversation_id}/participants/${args.actor_id}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta('remove_chat_participant', config, args.workspace_id),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ removed: true, actor_id: args.actor_id }),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'get_chat_activity',
		{
			description: tools.get_chat_activity.description,
			inputSchema: tools.get_chat_activity.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, conversation_id, actor_id, session_id, limit_turns } = args
			if (!conversation_id && !session_id) {
				throw new Error('Give a conversation_id (and optionally an actor_id), or a session_id.')
			}
			const wsOpts = { workspaceId: workspace_id }
			let targets: ChatSessionRow[]
			if (session_id) {
				const row = (await apiCall(
					config,
					'GET',
					`/api/sessions/${session_id}`,
					undefined,
					wsOpts,
				)) as Partial<ChatSessionRow>
				targets = [{ id: session_id, actorId: row.actorId ?? '', status: row.status ?? '' }]
			} else {
				const latest = latestSessionByActor(
					await fetchChatSessions(config, workspace_id, conversation_id as string),
				)
				targets = [...latest.values()].filter((s) => !actor_id || s.actorId === actor_id)
			}
			const wsId = workspace_id ?? config.defaultWorkspaceId
			const names = wsId ? await fetchActorNameMap(config, wsId) : {}
			const agents = await Promise.all(
				targets.map(async (s) => {
					const base = {
						actor_id: s.actorId,
						actor_name: names[s.actorId] ?? null,
						session_id: s.id,
						status: chatAgentStatus(s.status),
					}
					try {
						const activity = await apiCall(
							config,
							'GET',
							`/api/sessions/${s.id}/activity?limit_turns=${limit_turns ?? 3}`,
							undefined,
							wsOpts,
						)
						return { ...base, activity }
					} catch (err) {
						return { ...base, error: err instanceof Error ? err.message : String(err) }
					}
				}),
			)
			const payload = { agents }
			return {
				_meta: meta('get_chat_activity', config, workspace_id),
				// Same full payload on both channels (see known-pitfalls.md).
				content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
				structuredContent: payload,
			}
		},
	)

	registerAppTool(
		server,
		'stop_chat_agent',
		{
			description: tools.stop_chat_agent.description,
			inputSchema: tools.stop_chat_agent.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, conversation_id, actor_id, session_id } = args
			const wsOpts = { workspaceId: workspace_id }
			let sessionIds: string[]
			if (session_id) {
				sessionIds = [session_id]
			} else if (conversation_id && actor_id) {
				const rows = await fetchChatSessions(config, workspace_id, conversation_id)
				sessionIds = rows
					.filter((s) => s.actorId === actor_id && !ENDED_SESSION_STATUSES.includes(s.status))
					.map((s) => s.id)
			} else {
				throw new Error('Give a conversation_id and an actor_id, or a session_id.')
			}
			if (sessionIds.length === 0) {
				return {
					_meta: meta('stop_chat_agent', config, workspace_id),
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								stopped: false,
								note: 'That agent has nothing running in this chat, so there is nothing to stop.',
							}),
						},
					],
				}
			}
			const stopped: string[] = []
			for (const id of sessionIds) {
				await apiCall(config, 'POST', `/api/sessions/${id}/stop`, undefined, wsOpts)
				stopped.push(id)
			}
			return {
				_meta: meta('stop_chat_agent', config, workspace_id),
				content: [
					{ type: 'text' as const, text: JSON.stringify({ stopped: true, session_ids: stopped }) },
				],
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
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl) }],
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
			const pagination = resolveListPagination({ limit: args.limit, cursor: args.cursor })
			// `/api/triggers` still expects an `offset` query param — the cursor
			// keyset supersedes it for actual pagination, so this tool always
			// sends 0 rather than accept an offset param from the caller.
			const offset = 0
			const fetchCap = pagination.limit + 1
			const params = new URLSearchParams({ limit: String(fetchCap), offset: String(offset) })
			params.set('snapshot_at', pagination.snapshotAt)
			params.set('order', pagination.order)
			if (pagination.cursor) {
				params.set('cursor_created_at', pagination.cursor.k.sortValue)
				params.set('cursor_id', pagination.cursor.k.id)
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
			// heroCard.objects carries every row the API returned on this page —
			// `structuredContent` has no separate rich row array for this tool, so
			// trimming here would silently drop rows the caller can't recover
			// (the hero-card widget already caps display client-side, so a
			// larger array only means more data on the wire, not a wider render).
			const heroCard: HeroCardPayload =
				heroObjects.length === 0
					? { kind: 'empty', tool: 'list_triggers' }
					: heroObjects.length === 1 && totalCount === 1
						? { kind: 'single', tool: 'list_triggers', object: heroObjects[0] }
						: {
								kind: 'list',
								tool: 'list_triggers',
								objects: heroObjects,
								totalCount,
								page: {
									limit: heroObjects.length,
									offset,
									hasMore: offset + heroObjects.length < totalCount,
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
						text: buildListContentText(enriched),
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
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	// ─── Loops ────────────────────────────────────────────────
	// There is no dedicated write API for loops — `apps/dev/src/routes/loops.ts`
	// only implements GET. These tools are composite orchestrations over
	// existing generic endpoints instead: the loop object + `in_loop` edges go
	// through POST /api/graph (atomic) or PATCH/DELETE /api/objects/:id,
	// inline steps become ordinary triggers via POST /api/triggers, and
	// trigger membership lives in the loop's metadata.trigger_ids
	// (read-modify-written under the per-workspace lock). See tools.ts for the
	// loop model these expose.
	registerAppTool(
		server,
		'create_loop',
		{
			description: tools.create_loop.description,
			inputSchema: tools.create_loop.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const {
				workspace_id,
				name,
				content,
				status,
				entry_condition,
				close_condition,
				closed_statuses,
				closed_when,
				tags,
				targets,
			} = args
			const stepList = (args.steps ?? []) as LoopStepInput[]
			const existingTriggerIds = args.trigger_ids ?? []
			const memberObjectIds = args.object_ids ?? []
			// `status` always has a value here — the schema defaults it to
			// 'draft'. Only `paused` starts a loop's triggers disabled.
			const startEnabled = status !== 'paused'

			// Validate everything up-front so nothing is created on a bad request.
			await Promise.all([
				assertTriggersExist(config, existingTriggerIds, workspace_id),
				assertObjectsExist(config, memberObjectIds, workspace_id),
				assertAgentsExist(
					config,
					stepList.map((s) => s.agent_id),
					workspace_id,
				),
				assertLoopTypesValid(
					config,
					{ closedStatuses: closed_statuses, closedWhen: closed_when, steps: stepList },
					workspace_id,
				),
			])

			// Create inline step triggers first; if the loop insert fails we
			// best-effort delete them so no orphan triggers are left behind. Each
			// gets its own random Idempotency-Key (not the default derived-from-body
			// one) so two create_loop calls with byte-identical step bodies (e.g.
			// reused boilerplate) always create distinct trigger rows — otherwise
			// the second call's POST would replay the first call's trigger id, and
			// a later failure here would roll back (delete) a different, already
			// -successful loop's trigger.
			const stepTriggerIds: string[] = []
			let graphResult: {
				nodes: Array<Record<string, unknown> & { id: string }>
				edges: unknown[]
			}
			try {
				for (const step of stepList) {
					const created = (await apiCall(
						config,
						'POST',
						'/api/triggers',
						buildStepTriggerBody(step, startEnabled),
						{ workspaceId: workspace_id, idempotencyKey: `mcp:create_loop:step:${randomUUID()}` },
					)) as { id: string }
					stepTriggerIds.push(created.id)
				}

				const allTriggerIds = [...new Set([...existingTriggerIds, ...stepTriggerIds])]
				const metadata: Record<string, unknown> = { trigger_ids: allTriggerIds }
				if (entry_condition !== undefined) metadata.entry_condition = entry_condition
				if (close_condition !== undefined) metadata.close_condition = close_condition
				if (closed_statuses !== undefined) metadata.closed_statuses = closed_statuses
				if (closed_when !== undefined) metadata.closed_when = closed_when
				if (tags !== undefined) metadata.tags = tags
				if (targets !== undefined) metadata.targets = targets

				const node: Record<string, unknown> = {
					$id: 'loop',
					type: 'loop',
					title: name,
					status,
					metadata,
				}
				if (content !== undefined) node.content = content
				const edges = memberObjectIds.map((objectId) => ({
					source: 'loop',
					target: objectId,
					type: LOOP_MEMBERSHIP_TYPE,
				}))

				graphResult = (await apiCall(
					config,
					'POST',
					'/api/graph',
					{ nodes: [node], edges },
					{ workspaceId: workspace_id },
				)) as typeof graphResult
			} catch (err) {
				await Promise.all(
					stepTriggerIds.map((triggerId) =>
						apiCall(config, 'DELETE', `/api/triggers/${triggerId}`, undefined, {
							workspaceId: workspace_id,
						}).catch(() => undefined),
					),
				)
				throw err
			}

			const allTriggerIds = [...new Set([...existingTriggerIds, ...stepTriggerIds])]

			// Pre-existing triggers attached via `trigger_ids` were created by an
			// earlier call and default to enabled — if this loop starts paused,
			// disable them too so "paused" is true of every step, not just the
			// ones authored inline in this call. Best-effort: a failure here
			// surfaces as a warning rather than rolling back an already-created,
			// otherwise-successful loop.
			const disableFailures =
				!startEnabled && existingTriggerIds.length > 0
					? await setTriggersEnabled(config, existingTriggerIds, false, workspace_id)
					: []

			const created = graphResult.nodes[0]
			const wsId =
				(created?.workspaceId as string | undefined) ?? workspace_id ?? config.defaultWorkspaceId
			const loopWithUrl =
				created && wsId
					? addUrl(stripLoopOnlyFields(created), config, wsId, { kind: 'loop', id: created.id })
					: created
						? stripLoopOnlyFields(created)
						: null
			const steps = await fetchLoopStepsView(config, workspace_id, allTriggerIds)
			const responseBody: Record<string, unknown> = {
				loop: loopWithUrl,
				steps,
				member_objects: graphResult.edges,
			}
			if (stepTriggerIds.length > 0) responseBody.created_step_trigger_ids = stepTriggerIds
			if (disableFailures.length > 0) {
				responseBody.trigger_pause_warnings = `Loop created as paused, but these pre-existing triggers could not be disabled — pause them manually: ${disableFailures.join(', ')}`
			}

			// Same setup block update_loop/get_loop return. graphResult.edges.length
			// is the exact member count (not a floor) since these are the edges this
			// very call just created.
			if (created?.id) {
				responseBody.setup = await buildLoopSetupBlockFromApi(
					{
						id: created.id as string,
						name: (created.title as string | null | undefined) ?? name ?? null,
						entryCondition: entry_condition ?? null,
						closeCondition: close_condition ?? null,
					},
					setupApiCaller(config),
					{
						workspaceId: workspace_id,
						triggerIds: allTriggerIds,
						memberCount: graphResult.edges.length,
					},
				)
			}

			return {
				_meta: meta('create_loop', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(responseBody) }],
			}
		},
	)

	registerAppTool(
		server,
		'update_loop',
		{
			description: tools.update_loop.description,
			inputSchema: tools.update_loop.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const {
				workspace_id,
				id,
				name,
				content,
				status,
				entry_condition,
				close_condition,
				closed_statuses,
				closed_when,
				tags,
				targets,
				add_steps,
				add_trigger_ids,
				remove_trigger_ids,
				add_object_ids,
				remove_object_ids,
			} = args

			// The trigger_ids read-modify-write must not race a concurrent loop
			// update from this process — same locking discipline as the workspace
			// schema-editing tools.
			const lockKey = workspace_id ?? config.defaultWorkspaceId ?? 'default'
			return withWorkspaceLock(lockKey, async () => {
				const existing = (await apiCall(config, 'GET', `/api/objects/${id}`, undefined, {
					workspaceId: workspace_id,
				})) as Record<string, unknown>
				if (existing.type !== 'loop') {
					throw new Error(
						`Object ${id} has type '${String(existing.type)}', not 'loop'. update_loop only operates on loops — use update_objects for other objects, and list_loops to find loop ids.`,
					)
				}

				// The loop's status after this call — its own PATCH if `status` was
				// passed, else whatever it already was. Only `paused` means new
				// steps should start disabled; an explicit status transition
				// to/from `paused` is handled centrally by the PATCH /api/objects/:id
				// hook (apps/dev/src/routes/objects.ts), which also covers the
				// frontend's pause/resume button — this only needs to handle steps
				// being *added* to an already-paused loop in the same or a later call.
				const effectiveStatus = status ?? (existing.status as string | undefined)
				const stepsStartEnabled = effectiveStatus !== 'paused'

				await Promise.all([
					assertTriggersExist(config, add_trigger_ids ?? [], workspace_id),
					assertObjectsExist(config, add_object_ids ?? [], workspace_id),
					assertAgentsExist(
						config,
						((add_steps as LoopStepInput[] | undefined) ?? []).map((s) => s.agent_id),
						workspace_id,
					),
					assertLoopTypesValid(
						config,
						{
							closedStatuses: closed_statuses,
							closedWhen: closed_when,
							steps: add_steps as LoopStepInput[] | undefined,
						},
						workspace_id,
					),
				])

				// Inline steps become new triggers, appended alongside add_trigger_ids.
				// If the subsequent metadata PATCH fails, best-effort delete the
				// just-created triggers so they don't survive live and unattached to
				// any loop — mirrors create_loop's rollback. Each gets its own random
				// Idempotency-Key so it can't replay another call's trigger (see
				// create_loop for why).
				const stepTriggerIds: string[] = []
				let loopRow = existing
				let mergedTriggerIds: string[] = []
				let triggerIdsChanged = false
				try {
					for (const step of (add_steps ?? []) as LoopStepInput[]) {
						const created = (await apiCall(
							config,
							'POST',
							'/api/triggers',
							buildStepTriggerBody(step, stepsStartEnabled),
							{
								workspaceId: workspace_id,
								idempotencyKey: `mcp:update_loop:step:${randomUUID()}`,
							},
						)) as { id: string }
						stepTriggerIds.push(created.id)
					}

					// Read-modify-write metadata.trigger_ids. PATCH /api/objects
					// shallow-merges metadata, so only changed keys are sent.
					const currentMeta = (existing.metadata ?? {}) as Record<string, unknown>
					const currentTriggerIds = Array.isArray(currentMeta.trigger_ids)
						? currentMeta.trigger_ids.filter((v): v is string => typeof v === 'string')
						: []
					const removeSet = new Set(remove_trigger_ids ?? [])
					mergedTriggerIds = [
						...new Set([...currentTriggerIds, ...(add_trigger_ids ?? []), ...stepTriggerIds]),
					].filter((t) => !removeSet.has(t))
					triggerIdsChanged =
						mergedTriggerIds.length !== currentTriggerIds.length ||
						mergedTriggerIds.some((t, i) => currentTriggerIds[i] !== t)

					const metadataPatch: Record<string, unknown> = {}
					if (triggerIdsChanged) metadataPatch.trigger_ids = mergedTriggerIds
					if (entry_condition !== undefined) metadataPatch.entry_condition = entry_condition
					if (close_condition !== undefined) metadataPatch.close_condition = close_condition
					if (closed_statuses !== undefined) metadataPatch.closed_statuses = closed_statuses
					if (closed_when !== undefined) metadataPatch.closed_when = closed_when
					if (tags !== undefined) metadataPatch.tags = tags
					if (targets !== undefined) metadataPatch.targets = targets

					const body: Record<string, unknown> = {}
					if (name !== undefined) body.title = name
					if (content !== undefined) body.content = content
					if (status !== undefined) body.status = status
					if (Object.keys(metadataPatch).length > 0) body.metadata = metadataPatch

					if (Object.keys(body).length > 0) {
						loopRow = (await apiCall(config, 'PATCH', `/api/objects/${id}`, body, {
							workspaceId: workspace_id,
						})) as Record<string, unknown>
					}
				} catch (err) {
					await Promise.all(
						stepTriggerIds.map((triggerId) =>
							apiCall(config, 'DELETE', `/api/triggers/${triggerId}`, undefined, {
								workspaceId: workspace_id,
							}).catch(() => undefined),
						),
					)
					throw err
				}

				// Pre-existing triggers attached via `add_trigger_ids` default to
				// enabled — if the loop's effective status is `paused`, disable them
				// too so pausing stays true of every step, not just ones just
				// authored inline. Best-effort: a failure surfaces as a warning
				// rather than undoing an otherwise-successful update.
				const disableFailures =
					!stepsStartEnabled && (add_trigger_ids ?? []).length > 0
						? await setTriggersEnabled(config, add_trigger_ids ?? [], false, workspace_id)
						: []

				// Membership adds — POST /api/relationships is idempotent on
				// (source, target, type), so re-adding an existing member is safe.
				const addedObjectIds: string[] = []
				for (const objectId of add_object_ids ?? []) {
					await apiCall(
						config,
						'POST',
						'/api/relationships',
						{
							source_type: 'object',
							source_id: id,
							target_type: 'object',
							target_id: objectId,
							type: LOOP_MEMBERSHIP_TYPE,
						},
						{ workspaceId: workspace_id },
					)
					addedObjectIds.push(objectId)
				}

				// Membership removals: collect every matching `in_loop` edge first
				// (deleting while paging would shift offsets), then delete.
				const removedObjectIds: string[] = []
				const notMembers: string[] = []
				if (remove_object_ids?.length) {
					const pendingRemove = new Set(remove_object_ids)
					const matched: Array<{ relId: string; targetId: string }> = []
					let offset = 0
					for (;;) {
						const page = (await apiCall(
							config,
							'GET',
							`/api/relationships?source_id=${id}&type=${LOOP_MEMBERSHIP_TYPE}&limit=${RELATIONSHIP_PAGE_LIMIT}&offset=${offset}`,
							undefined,
							{ workspaceId: workspace_id },
						)) as Array<{ id: string; targetId: string }>
						if (!Array.isArray(page) || page.length === 0) break
						for (const rel of page) {
							if (pendingRemove.has(rel.targetId)) {
								matched.push({ relId: rel.id, targetId: rel.targetId })
								pendingRemove.delete(rel.targetId)
							}
						}
						if (page.length < RELATIONSHIP_PAGE_LIMIT || pendingRemove.size === 0) break
						offset += RELATIONSHIP_PAGE_LIMIT
					}
					for (const { relId, targetId } of matched) {
						await apiCall(config, 'DELETE', `/api/relationships/${relId}`, undefined, {
							workspaceId: workspace_id,
						})
						removedObjectIds.push(targetId)
					}
					notMembers.push(...pendingRemove)
				}

				const wsId =
					(loopRow.workspaceId as string | undefined) ?? workspace_id ?? config.defaultWorkspaceId
				const loopWithUrl = wsId
					? addUrl(stripLoopOnlyFields(loopRow), config, wsId, { kind: 'loop', id })
					: stripLoopOnlyFields(loopRow)

				// Member count is intentionally best-effort: re-listing every in_loop
				// edge just for the setup block would blow the ≤4-extra-call budget.
				// `addedObjectIds.length` is the floor for calls that add members;
				// otherwise we skip the has_members check by passing `1` (T4's
				// get_loop path computes the real number when it matters).
				const loopMeta = (loopRow.metadata as Record<string, unknown> | null) ?? {}
				const effectiveTriggerIds =
					mergedTriggerIds.length > 0
						? mergedTriggerIds
						: Array.isArray(loopMeta.trigger_ids)
							? (loopMeta.trigger_ids as unknown[]).filter(
									(v): v is string => typeof v === 'string',
								)
							: []
				const memberCount = addedObjectIds.length > 0 ? addedObjectIds.length : 1

				const responseBody: Record<string, unknown> = {
					loop: loopWithUrl,
					steps: await fetchLoopStepsView(config, workspace_id, effectiveTriggerIds),
				}
				if (stepTriggerIds.length > 0) responseBody.created_step_trigger_ids = stepTriggerIds
				if (addedObjectIds.length > 0) responseBody.added_object_ids = addedObjectIds
				if (removedObjectIds.length > 0) responseBody.removed_object_ids = removedObjectIds
				if (notMembers.length > 0) responseBody.not_members_skipped = notMembers
				if (disableFailures.length > 0) {
					responseBody.trigger_pause_warnings = `Loop is paused, but these newly-attached triggers could not be disabled — pause them manually: ${disableFailures.join(', ')}`
				}

				responseBody.setup = await buildLoopSetupBlockFromApi(
					{
						id,
						name: (loopRow.title as string | null | undefined) ?? name ?? null,
						entryCondition:
							(loopMeta.entry_condition as string | null | undefined) ?? entry_condition ?? null,
						closeCondition:
							(loopMeta.close_condition as string | null | undefined) ?? close_condition ?? null,
					},
					setupApiCaller(config),
					{
						workspaceId: workspace_id,
						triggerIds: effectiveTriggerIds,
						memberCount,
					},
				)
				return {
					_meta: meta('update_loop', config, (args as { workspace_id?: string }).workspace_id),
					content: [{ type: 'text' as const, text: JSON.stringify(responseBody) }],
				}
			})
		},
	)

	registerAppTool(
		server,
		'list_loops',
		{
			description: tools.list_loops.description,
			inputSchema: tools.list_loops.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const pagination = resolveListPagination({
				limit: (args as { limit?: number }).limit,
				cursor: (args as { cursor?: string }).cursor,
			})
			const data = (await apiCall(config, 'GET', '/api/loops', undefined, {
				workspaceId: args.workspace_id,
			})) as { loops: Array<Record<string, unknown>> }
			const wsId = args.workspace_id ?? config.defaultWorkspaceId
			const loops = Array.isArray(data?.loops) ? data.loops : []
			const { page: pagedLoops, nextCursor } = paginateClientSide({
				rows: loops,
				limit: pagination.limit,
				snapshotAt: pagination.snapshotAt,
				order: pagination.order,
				cursor: pagination.cursor,
				getSortValue: (row) => (row.createdAt as string | null | undefined) ?? null,
				getId: (row) => row.id as string,
			})
			// Deliberately lean: id/workspaceId/name/url only, so listing many
			// loops stays cheap. Live stats, conditions, steps, and the rest of
			// the loop row live on get_loop — call it with a specific id to get
			// the full picture (and the trigger+agent-nested `steps` view).
			const enriched = pagedLoops.map((loop) => {
				const trimmed: Record<string, unknown> = {
					id: loop.id,
					workspaceId: loop.workspaceId,
					name: loop.name,
				}
				return addUrl(trimmed, config, (loop.workspaceId as string | undefined) ?? wsId, {
					kind: 'loop',
					id: loop.id as string,
				})
			})
			const payload = buildListPayload({
				key: 'loops',
				rows: enriched,
				limit: pagination.limit,
				nextCursor,
				total: loops.length,
			})
			return {
				_meta: meta('list_loops', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: listText(payload) }],
				structuredContent: payload,
			}
		},
	)

	registerAppTool(
		server,
		'get_loop',
		{
			description: tools.get_loop.description,
			inputSchema: tools.get_loop.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, id } = args
			const data = (await apiCall(
				config,
				'GET',
				`/api/loops?id=${encodeURIComponent(id)}`,
				undefined,
				{ workspaceId: workspace_id },
			)) as { loops: Array<Record<string, unknown>> }
			const loop = Array.isArray(data?.loops) ? data.loops[0] : undefined
			if (!loop) {
				throw new Error(
					`Loop ${id} not found in this workspace. Use list_loops to find valid loop ids.`,
				)
			}
			const wsId =
				(loop.workspaceId as string | undefined) ?? workspace_id ?? config.defaultWorkspaceId
			const loopWithUrl = wsId ? addUrl(loop, config, wsId, { kind: 'loop', id }) : loop

			// Same nested trigger+agent view create_loop/update_loop return by
			// default (fetchLoopStepsView) — get_loop previously only exposed
			// flat `loop.triggerIds`/`loop.agentIds`, forcing a caller to
			// separately fetch list_triggers + list_actors and correlate them by
			// hand to see which agent runs which step.
			const triggerIds = Array.isArray(loop.triggerIds)
				? (loop.triggerIds as string[]).filter((t): t is string => typeof t === 'string')
				: []
			const steps = await fetchLoopStepsView(config, workspace_id, triggerIds)

			const responseBody: Record<string, unknown> = { loop: loopWithUrl, steps }

			// get_loop already has the loop's own inProgressCount/closedCount from
			// /api/loops, so — unlike update_loop's best-effort member count — this
			// is the real number, not a floor.
			const memberCount =
				(typeof loop.inProgressCount === 'number' ? loop.inProgressCount : 0) +
				(typeof loop.closedCount === 'number' ? loop.closedCount : 0)
			responseBody.setup = await buildLoopSetupBlockFromApi(
				{
					id,
					name: (loop.name as string | null | undefined) ?? null,
					entryCondition: (loop.entryCondition as string | null | undefined) ?? null,
					closeCondition: (loop.closeCondition as string | null | undefined) ?? null,
				},
				setupApiCaller(config),
				{
					workspaceId: workspace_id,
					triggerIds,
					memberCount,
				},
			)

			return {
				_meta: meta('get_loop', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(responseBody) }],
			}
		},
	)

	registerAppTool(
		server,
		'delete_loop',
		{
			description: tools.delete_loop.description,
			inputSchema: tools.delete_loop.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, id } = args
			const lockKey = workspace_id ?? config.defaultWorkspaceId ?? 'default'
			return withWorkspaceLock(lockKey, async () => {
				const existing = (await apiCall(config, 'GET', `/api/objects/${id}`, undefined, {
					workspaceId: workspace_id,
				})) as Record<string, unknown>
				if (existing.type !== 'loop') {
					throw new Error(
						`Object ${id} has type '${String(existing.type)}', not 'loop'. delete_loop only operates on loops — use delete_object for other objects, and list_loops to find loop ids.`,
					)
				}

				const removedObjectIds = await deleteAllLoopMemberships(config, id, workspace_id)
				await apiCall(config, 'DELETE', `/api/objects/${id}`, undefined, {
					workspaceId: workspace_id,
				})

				return {
					_meta: meta('delete_loop', config, (args as { workspace_id?: string }).workspace_id),
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(
								{ deleted: true, removed_member_object_ids: removedObjectIds },
								null,
								2,
							),
						},
					],
				}
			})
		},
	)

	// ─── Notifications ────────────────────────────────────────
	// create_notification, list_notifications and update_notification are live: the
	// Chief of Staff curates the For You list with them. get_notification and
	// delete_notification stay hidden while we rethink the wider notification flow;
	// their definitions remain in `tools.ts`, so re-enabling is uncommenting them.
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_for_you',
		{
			description: tools.list_for_you.description,
			inputSchema: tools.list_for_you.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams({ for_actor_id: args.actor_id })
			const result = (await apiCall(config, 'GET', `/api/for-you?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as { items?: ForYouItemLike[] }
			const payload = slimForYouItems(
				Array.isArray(result?.items) ? result.items : [],
				args.limit ?? FOR_YOU_TOOL_DEFAULT_LIMIT,
				args.offset ?? 0,
			)
			return {
				_meta: meta('list_for_you', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
				structuredContent: payload,
			}
		},
	)

	registerAppTool(
		server,
		'withdraw_decision_card',
		{
			description: tools.withdraw_decision_card.description,
			inputSchema: tools.withdraw_decision_card.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/for-you/withdrawals', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: meta(
					'withdraw_decision_card',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			if (args.kind) params.set('kind', args.kind)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/notifications?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: meta('list_notifications', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	/*
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)
	*/

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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	/*
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)
	*/

	// ─── Subscriptions ────────────────────────────────────────
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
			const pagination = resolveListPagination({
				limit: (args as { limit?: number }).limit,
				cursor: (args as { cursor?: string }).cursor,
			})
			const params = new URLSearchParams()
			if (args.entity_type) params.set('entity_type', args.entity_type)
			const qs = params.toString()
			const path = qs ? `/api/subscriptions/unread?${qs}` : '/api/subscriptions/unread'
			const result = (await apiCall(config, 'GET', path, undefined, {
				workspaceId: args.workspace_id,
			})) as {
				items?: Array<{
					entity_id: string
					entity_type?: string
					unread_count?: number
					latest_activity_at?: string | null
					latest_event_id?: number | null
					object?: { title?: string } | null
				}>
			}
			const items = Array.isArray(result?.items) ? result.items : []
			const { page: pagedItems, nextCursor } = paginateClientSide({
				rows: items,
				limit: pagination.limit,
				snapshotAt: pagination.snapshotAt,
				order: pagination.order,
				cursor: pagination.cursor,
				getSortValue: (row) => row.latest_activity_at ?? null,
				getId: (row) => row.entity_id,
			})
			const payload = buildListPayload({
				key: 'items',
				rows: pagedItems,
				limit: pagination.limit,
				nextCursor,
				total: items.length,
			})
			return {
				_meta: meta('list_unread', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: listText(payload) }],
				structuredContent: payload,
			}
		},
	)

	// ─── Sessions ─────────────────────────────────────────────
	// create_sub_chat is the new name for create_session: one handler, two names, so
	// prompts that still say create_session keep working.
	for (const toolName of ['create_sub_chat', 'create_session'] as const) {
		registerAppTool(
			server,
			toolName,
			{
				description: tools[toolName].description,
				inputSchema: tools[toolName].inputSchema.shape,
				_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
			},
			async (args) => {
				if (args.wait) return createSessionAndWait(config, args, toolName)

				// `wait` never goes to the create route. The result is always sent back to
				// the caller, with no opt-out: not waiting means not holding the call open,
				// not never finding out how it went.
				const { workspace_id, wait, ...rest } = args
				const createBody = { ...rest, notify_on_complete: true }

				let result: SessionRow
				try {
					result = (await apiCall(config, 'POST', '/api/sessions', createBody, {
						workspaceId: workspace_id,
					})) as SessionRow
				} catch (err) {
					return sessionNotStartedResult(config, toolName, workspace_id, err)
				}
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
					_meta: meta(toolName, config, (args as { workspace_id?: string }).workspace_id),
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								...withUrl,
								handoff: handoffNote(enriched, (withUrl as { url?: unknown }).url),
							}),
						},
					],
				}
			},
		)
	}

	// Listed alias of create_session with wait on (see tool-aliases.ts). Registered
	// through the same wrapper as a real tool, so it gets the same tool_call row,
	// size event, token cap and mutation event. The handler calls the wait path of
	// create_session directly rather than the registered create_session handler,
	// which would record a second tool_call row for one call.
	//
	// Argument mapping, derived from run_agent as it was before PR 1986:
	//   actor_id, action_prompt, spawned_by_message_id  carried over one to one
	//   workspace_id                                    filled from the default when absent
	//   notify_on_complete                              accepted and ignored: create_session no longer
	//                                                   takes it and registers the same fallback itself
	//                                                   when the wait times out
	//   config, poll_interval_seconds, timeout_seconds,
	//   depends_on_session_ids                          no equivalent, dropped, names recorded
	// The upstream signature accepts a raw shape; this tool passes a schema object
	// (the alias layer's preprocess wrapper), so the narrow type is spelled out
	// here. It is still registered through the same wrapper as every other tool.
	const registerWrappedSchemaTool = registerAppTool as unknown as (
		s: typeof server,
		name: string,
		definition: {
			description: string
			inputSchema: z.ZodTypeAny
			_meta: Record<string, unknown>
		},
		handler: (args: z.infer<typeof tools.run_agent.inputSchema>) => Promise<unknown>,
	) => unknown
	registerWrappedSchemaTool(
		server,
		'run_agent',
		{
			description: tools.run_agent.description,
			// The dropped key names are read in this preprocess step, before the
			// schema strips them, and before validation, so a call that then fails
			// validation is still counted. Same wrapper the alias rows use; this
			// tool has no alias rows, so registerAppTool leaves the schema as given.
			inputSchema: wrapInputSchema(tools.run_agent.inputSchema.shape, (raw) => {
				const sent =
					typeof raw === 'object' && raw !== null && !Array.isArray(raw)
						? (raw as Record<string, unknown>)
						: {}
				recordAliasUse(telemetrySink, telemetryTarget, {
					tool_name: 'run_agent',
					workspace_id: extractWorkspaceId(raw),
					dropped_keys: RUN_AGENT_DROPPED_KEYS.filter((key) => key in sent),
					tool_alias: { old: 'run_agent', new: TOOL_NAME_ALIASES.run_agent },
					transport: config.transport,
				})
				return raw
			}),
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, actor_id, action_prompt, spawned_by_message_id } = args
			return createSessionAndWait(config, {
				workspace_id: workspace_id ?? config.defaultWorkspaceId,
				actor_id,
				action_prompt,
				spawned_by_message_id,
				wait: true,
			})
		},
	)

	registerAppTool(
		server,
		'ask_user_question',
		{
			description: tools.ask_user_question.description,
			inputSchema: tools.ask_user_question.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const reply = (text: string) => ({
				_meta: meta('ask_user_question', config, undefined),
				content: [{ type: 'text' as const, text }],
			})
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			if (!sessionId) {
				return reply(
					'There is nobody to ask: this is not running inside an agent session. Decide for yourself and state the assumption you made.',
				)
			}
			let deliveredTo: string | undefined
			try {
				const posted = (await apiCall(config, 'POST', `/api/sessions/${sessionId}/ask`, {
					questions: args.questions.map((q) => ({
						question: q.question,
						header: q.header,
						multi_select: q.multi_select ?? false,
						options: q.options,
					})),
				})) as { delivered_to?: string } | undefined
				deliveredTo = posted?.delivered_to
			} catch (err) {
				// 409 is the normal answer for a session with no chat to ask in.
				console.error('ask_user_question: could not post the question', err)
				return reply(
					'Nobody could be asked from this session. Decide for yourself, state the assumption you made, and continue.',
				)
			}
			if (deliveredTo === 'chief_of_staff') {
				return reply(
					'Your question has been sent to the person in their chat with the Chief of Staff. Their answer goes there, not back to this session, so do not wait for it. Choose the most reasonable option yourself, state the assumption you made, and continue.',
				)
			}
			return reply(
				'Your question has been posted and the person is being shown the options. Do not call this tool again and do not repeat the question in your own words. End your turn now, without a closing message; their answer will arrive as your next turn.',
			)
		},
	)

	// Called by the Approve button inside the preview card (an MCP App), never by the model:
	// `visibility: ['app']` keeps it out of the tool list the agent sees, and the server
	// refuses a caller that is not a person. So a model cannot approve its own draft.
	registerAppTool(
		server,
		'approve_object_draft',
		{
			description: tools.approve_object_draft.description,
			inputSchema: tools.approve_object_draft.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, visibility: ['app'] } },
		},
		async (args) => {
			const reply = (text: string, isError = false) => ({
				_meta: meta('approve_object_draft', config, args.workspace_id),
				content: [{ type: 'text' as const, text }],
				...(isError ? { isError: true } : {}),
			})
			try {
				await apiCall(
					config,
					'POST',
					`/api/objects/${args.object_id}/approval`,
					args.content_hash ? { content_hash: args.content_hash } : {},
					{ workspaceId: args.workspace_id },
				)
				return reply('Approved. The agent can now send it.')
			} catch (err) {
				return reply(err instanceof Error ? err.message : String(err), true)
			}
		},
	)

	registerAppTool(
		server,
		'gmail_send_email',
		{
			description: tools.gmail_send_email.description,
			inputSchema: tools.gmail_send_email.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const reply = (text: string, isError = false) => ({
				_meta: meta('gmail_send_email', config, args.workspace_id),
				content: [{ type: 'text' as const, text }],
				...(isError ? { isError: true } : {}),
			})
			try {
				const sent = (await apiCall(
					config,
					'POST',
					'/api/integrations/gmail/send',
					{
						to: args.to,
						cc: args.cc,
						subject: args.subject,
						body: args.body,
						approval_comment_id: args.approval_comment_id,
						draft_id: args.draft_id,
						object_id: args.object_id,
					},
					{ workspaceId: args.workspace_id },
				)) as { message_id: string; mode: 'approved_draft' | 'direct' }
				return reply(
					sent.mode === 'approved_draft'
						? 'Sent: the email went out exactly as the person approved it. Do not send it again.'
						: 'Sent. Do not send it again.',
				)
			} catch (err) {
				// The server words every refusal for the agent (what happened, what to do next),
				// so pass it on as a result instead of a thrown error.
				if (parseApiErrorStatus(err) === null) throw err
				const detail = (err instanceof Error ? err.message : String(err)).replace(
					/^API error \d{3}:\s*/,
					'',
				)
				return reply(`Not sent. ${detail}`, true)
			}
		},
	)

	registerAppTool(
		server,
		'resend_send_email',
		{
			description: tools.resend_send_email.description,
			inputSchema: tools.resend_send_email.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const reply = (text: string, isError = false) => ({
				_meta: meta('resend_send_email', config, args.workspace_id),
				content: [{ type: 'text' as const, text }],
				...(isError ? { isError: true } : {}),
			})
			try {
				const sent = (await apiCall(
					config,
					'POST',
					'/api/integrations/resend/send',
					{ object_id: args.object_id },
					{ workspaceId: args.workspace_id },
				)) as { email_id: string; from: string }
				return reply(
					`Sent from ${sent.from}: the email went out exactly as the person approved it. Do not send it again.`,
				)
			} catch (err) {
				// The server words every refusal for the agent (what happened, what to do next),
				// so pass it on as a result instead of a thrown error.
				if (parseApiErrorStatus(err) === null) throw err
				const detail = (err instanceof Error ? err.message : String(err)).replace(
					/^API error \d{3}:\s*/,
					'',
				)
				return reply(`Not sent. ${detail}`, true)
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
			if (args.trigger_id) params.set('trigger_id', args.trigger_id)
			if (args.updated_before) params.set('updated_before', args.updated_before)
			if (args.updated_after) params.set('updated_after', args.updated_after)
			if (args.before) params.set('before', args.before)
			if (args.verbose) params.set('verbose', 'true')
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
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(withUrls),
					},
				],
				structuredContent: { sessions: withUrls },
				// If the token cap trims this page, the walk resumes after the last row that
				// ships. list_sessions pages on `before` (updated_at), so the cursor is that value.
				[RESUME_CURSOR]: (lastShipped: unknown) => {
					const row = lastShipped as { updated_at?: unknown; updatedAt?: unknown }
					const updatedAt = row.updated_at ?? row.updatedAt
					return typeof updatedAt === 'string' ? updatedAt : null
				},
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
			if (args.wait) {
				const current = (await apiCall(
					config,
					'GET',
					`/api/sessions/${args.id}`,
					undefined,
					wsOpts,
				)) as { id: string; status: string }
				return waitForSessionResult(config, {
					toolName: 'get_session',
					workspaceId: args.workspace_id,
					session: current,
					judgeFirst: true,
				})
			}
			const params = new URLSearchParams()
			if (args.include_logs) {
				params.set('include_logs', 'true')
				if (args.log_limit) params.set('log_limit', String(args.log_limit))
			}
			const query = params.toString()
			const path = `/api/sessions/${args.id}${query ? `?${query}` : ''}`
			const raw = (await apiCall(config, 'GET', path, undefined, wsOpts)) as SessionRow & {
				logs?: unknown[]
			}
			const { logs, ...session } = raw
			const enriched = await enrichSessionActorName(config, wsId, session as SessionRow)
			const sessionWithUrl = wsId
				? addUrl(enriched as Record<string, unknown>, config, wsId, {
						kind: 'session',
						id: enriched.id,
						actorId: (enriched as { actorId?: string }).actorId,
					})
				: enriched

			if (args.include_logs) {
				return {
					_meta: meta('get_session', config, (args as { workspace_id?: string }).workspace_id),
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ session: sessionWithUrl, logs: logs ?? [] }),
						},
					],
				}
			}

			return {
				_meta: meta('get_session', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(sessionWithUrl) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_session_logs',
		{
			description: tools.get_session_logs.description,
			inputSchema: tools.get_session_logs.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			params.set('direction', args.direction)
			params.set('limit', String(args.limit))
			if (args.before_id !== undefined) params.set('before_id', String(args.before_id))
			if (args.after_id !== undefined) params.set('after_id', String(args.after_id))
			if (args.stream) params.set('stream', args.stream)
			const logs = await apiCall(
				config,
				'GET',
				`/api/sessions/${args.id}/logs/deep?${params}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta('get_session_logs', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(logs) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_session_activity',
		{
			description: tools.get_session_activity.description,
			inputSchema: tools.get_session_activity.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.limit_turns) params.set('limit_turns', String(args.limit_turns))
			if (args.message_id !== undefined) params.set('message_id', String(args.message_id))
			if (args.before_log_id !== undefined) params.set('before_log_id', String(args.before_log_id))
			const activity = (await apiCall(
				config,
				'GET',
				`/api/sessions/${args.id}/activity?${params}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)) as Record<string, unknown>
			return {
				_meta: meta('get_session_activity', config, args.workspace_id),
				// Same full payload on both channels (see known-pitfalls.md).
				content: [{ type: 'text' as const, text: JSON.stringify(activity) }],
				structuredContent: activity,
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
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(withUrl) }],
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
			const { workspace_id, id, message, wait } = args
			const wsOpts = { workspaceId: workspace_id }
			const wsId = workspace_id ?? config.defaultWorkspaceId
			const reply = (body: unknown) => ({
				_meta: meta('resume_session', config, workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(body) }],
			})

			// One tool for every way a session can be not running: look at where it is and
			// take the matching route. A paused session is restored from its snapshot; one
			// that has ended gets a follow-up session in the same thread.
			const before = (await apiCall(
				config,
				'GET',
				`/api/sessions/${id}`,
				undefined,
				wsOpts,
			)) as SessionRow & { status: string }

			if (before.status === 'paused') {
				const resumed = (await apiCall(
					config,
					'POST',
					`/api/sessions/${id}/resume`,
					undefined,
					wsOpts,
				)) as SessionRow
				let messageNote: { message_delivered: false; message_note: string } | undefined
				if (message) {
					if (await waitUntilSessionRunning(config, workspace_id, id)) {
						await sendSessionInput(config, workspace_id, id, message)
					} else {
						messageNote = {
							message_delivered: false,
							message_note:
								'The session was resumed but is not running yet, so your message was not delivered. Send it with send_session_message once it is.',
						}
					}
				}
				if (wait) {
					return waitForSessionResult(config, {
						toolName: 'resume_session',
						workspaceId: workspace_id,
						session: { id, status: resumed.status as string },
					})
				}
				return reply({ ...(await presentSession(config, wsId, resumed)), ...messageNote })
			}

			if (ENDED_SESSION_STATUSES.includes(before.status)) {
				const { session_id: followUpId } = (await apiCall(
					config,
					'POST',
					`/api/sessions/${id}/continue`,
					{ content: message ?? DEFAULT_CONTINUE_MESSAGE },
					wsOpts,
				)) as { session_id: string }
				if (wait) {
					return waitForSessionResult(config, {
						toolName: 'resume_session',
						workspaceId: workspace_id,
						session: { id: followUpId, status: 'pending' },
					})
				}
				const followUp = (await apiCall(
					config,
					'GET',
					`/api/sessions/${followUpId}`,
					undefined,
					wsOpts,
				)) as SessionRow
				return reply({
					...(await presentSession(config, wsId, followUp)),
					continued_from_session_id: id,
				})
			}

			throw sessionStateError(before.status, id)
		},
	)

	registerAppTool(
		server,
		'send_session_message',
		{
			description: tools.send_session_message.description,
			inputSchema: tools.send_session_message.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.sessions, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, id, content, wait } = args
			const wsOpts = { workspaceId: workspace_id }

			// Waiting only makes sense for a session that ends after its reply (a helper
			// started from a chat). One that stays open never finishes, so with no time
			// limit waiting on it would never return: deliver the message and say so.
			let waitable = false
			let session: { id: string; status: string } | undefined
			if (wait) {
				const row = (await apiCall(config, 'GET', `/api/sessions/${id}`, undefined, wsOpts)) as {
					id: string
					status: string
					config?: { stop_on_result?: unknown } | null
				}
				session = row
				waitable = row.config?.stop_on_result === true
			}

			await sendSessionInput(config, workspace_id, id, content)

			if (wait && waitable && session) {
				return waitForSessionResult(config, {
					toolName: 'send_session_message',
					workspaceId: workspace_id,
					session,
				})
			}
			return {
				_meta: meta('send_session_message', config, workspace_id),
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({
							delivered: true,
							session_id: id,
							...(wait
								? {
										waited: false,
										note: 'This session stays open after replying, so there is nothing to wait for. Read its reply with get_session_activity.',
									}
								: {}),
						}),
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
			const input = args as {
				limit?: number
				cursor?: string
				provider?: string
				status?: string
				q?: string
				verbose?: boolean
				workspace_id?: string
			}
			// The whole list is fetched and paged here, so the full page size is available: there is
			// no "+ 1" sentinel to leave room for.
			const pagination = resolveListPagination({
				limit: input.limit,
				cursor: input.cursor,
				maxLimit: LIST_ENDPOINT_MAX_LIMIT,
			})
			const result = (await apiCall(config, 'GET', '/api/integrations', undefined, {
				workspaceId: args.workspace_id,
			})) as unknown
			const allRows = Array.isArray(result) ? (result as IntegrationRow[]) : []
			// Filters apply before paging, so `total` and `has_more` describe the matches. A row added
			// after the walk began stays out of every hop of it.
			const matching = allRows.filter(
				(row) =>
					matchesIntegrationFilters(row, input) &&
					(!row.createdAt || row.createdAt <= pagination.snapshotAt),
			)
			// Live connections first, then the newest. The cursor carries that composite key, so the
			// snapshot check above stands in for the one `paginateClientSide` would do on a timestamp.
			const { page: pagedRows, nextCursor } = paginateClientSide({
				rows: matching,
				limit: pagination.limit,
				snapshotAt: pagination.snapshotAt,
				order: 'desc',
				cursor: pagination.cursor,
				getSortValue: integrationSortKey,
				getId: (row) => row.id,
				applySnapshotFilter: false,
			})
			const rows = input.verbose ? pagedRows : pagedRows.map(leanIntegrationRow)
			// Judged over every row, not just this page: a broken connection must not depend on
			// which page it landed on.
			const reconnectHint = buildReconnectHint(allRows)
			const payload = buildListPayload({
				key: 'integrations',
				rows,
				limit: pagination.limit,
				nextCursor,
				total: matching.length,
				extra: { summary: summarizeIntegrations(allRows) },
				notes: reconnectHint ? [reconnectHint] : [],
			})
			return {
				_meta: meta('list_integrations', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: listText(payload) }],
				structuredContent: payload,
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
			const result = (await apiCall(config, 'GET', '/api/integrations/providers', undefined, {
				skipWorkspace: true,
			})) as Array<Record<string, unknown>>
			const rows = Array.isArray(result) ? result : []
			return {
				_meta: meta('list_integration_providers', config),
				content: [
					{
						type: 'text' as const,
						text: buildListContentText(result),
					},
				],
				structuredContent: { providers: rows },
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
			// Inside a chat session the human connects through a card in the chat:
			// an OAuth button, or an input for an API key. The credential never
			// passes through the model, and no URL has to be pasted. A 409 means
			// the session has no human on the other end (autonomous run, or not an
			// agent session at all) — fall through to the URL flow below.
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			if (sessionId && UUID_RE.test(sessionId)) {
				try {
					const card = (await apiCall(
						config,
						'POST',
						`/api/sessions/${sessionId}/connect-card`,
						{ provider: args.provider },
						{ workspaceId: args.workspace_id },
					)) as { posted: boolean; already_connected?: boolean }
					const text = card.already_connected
						? `${args.provider} is already connected in this workspace — nothing to do, carry on.`
						: `A Connect card for ${args.provider} is now in the chat. The user completes the connection there (they sign in, or paste their own API key into the card). Do not ask the user for an API key and do not paste a link. End your turn now without a closing message; they will tell you when it is connected.`
					return {
						_meta: meta(
							'connect_integration',
							config,
							(args as { workspace_id?: string }).workspace_id,
						),
						content: [{ type: 'text' as const, text }],
					}
				} catch (err) {
					if (parseApiErrorStatus(err) !== 409) throw err
				}
			}

			const result = (await apiCall(
				config,
				'POST',
				`/api/integrations/${args.provider}/connect`,
				args.api_key ? { api_key: args.api_key } : undefined,
				{ workspaceId: args.workspace_id },
			)) as {
				install_url?: string
			}
			// API-key providers activate synchronously and return no install_url.
			const text = result.install_url
				? `Open this URL in your browser to complete the installation:\n\n${result.install_url}\n\n${JSON.stringify(result)}`
				: `Integration connected.\n\n${JSON.stringify(result)}`
			return {
				_meta: meta(
					'connect_integration',
					config,
					(args as { workspace_id?: string }).workspace_id,
				),
				content: [{ type: 'text' as const, text }],
			}
		},
	)

	registerAppTool(
		server,
		'request_keychain_credential',
		{
			description: tools.request_keychain_credential.description,
			inputSchema: tools.request_keychain_credential.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			// The human fills in a card in the chat; the value goes straight to the vault and
			// never passes through the model. A 409 means the session has no human on the
			// other end (autonomous run, or not an agent session at all).
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			const toolMeta = meta(
				'request_keychain_credential',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			if (!sessionId || !UUID_RE.test(sessionId)) {
				return {
					_meta: toolMeta,
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: 'There is no chat to show a card in. Say in your reply what credential you need and where the user can add it (Settings → Keychain). Do not ask for the secret in plain text.',
						},
					],
				}
			}
			try {
				await apiCall(
					config,
					'POST',
					`/api/sessions/${sessionId}/keychain-card`,
					{
						kind: args.kind,
						...(args.suggested_name ? { suggested_name: args.suggested_name } : {}),
						...(args.hint ? { hint: args.hint } : {}),
						...(args.target_agent_ids?.length ? { target_agent_ids: args.target_agent_ids } : {}),
					},
					{ workspaceId: args.workspace_id },
				)
			} catch (err) {
				if (parseApiErrorStatus(err) !== 409) throw err
				return {
					_meta: toolMeta,
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: 'This session has no person in a chat to ask, so no card could be shown. Say in your reply what credential you need and where it can be added (Settings → Keychain). Do not ask for the secret in plain text.',
						},
					],
				}
			}
			return {
				_meta: toolMeta,
				content: [
					{
						type: 'text' as const,
						text: `A Keychain card for ${args.kind === 'login' ? 'a login' : 'an API key'}${args.suggested_name ? ` (${args.suggested_name})` : ''} is now in the chat. The user types it in there and it goes straight to their vault; you never see it. Do not ask the user to paste the secret in chat. End your turn now without a closing message; they will tell you when it is saved, and you will be restarted with it. ${args.kind === 'login' ? 'A login is never in your environment: type it on your computer with desktop_type, using {{keychain:<Name>.username}} and {{keychain:<Name>.password}}.' : 'It is in your environment as KEYCHAIN_BYO_APIKEY_<NAME>.'}`,
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'list_keychain_credentials',
		{
			description: tools.list_keychain_credentials.description,
			inputSchema: tools.list_keychain_credentials.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			const toolMeta = meta(
				'list_keychain_credentials',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			if (!sessionId || !UUID_RE.test(sessionId)) {
				return {
					_meta: toolMeta,
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: 'This is not an agent session, so there is no Keychain to list.',
						},
					],
				}
			}
			const result = await apiCall(
				config,
				'GET',
				`/api/sessions/${sessionId}/keychain-credentials`,
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: toolMeta,
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
				structuredContent: result as Record<string, unknown>,
			}
		},
	)

	registerAppTool(
		server,
		'request_keychain_access',
		{
			description: tools.request_keychain_access.description,
			inputSchema: tools.request_keychain_access.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			const toolMeta = meta(
				'request_keychain_access',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			const fail = (text: string) => ({
				_meta: toolMeta,
				isError: true,
				content: [{ type: 'text' as const, text }],
			})
			if (!sessionId || !UUID_RE.test(sessionId)) {
				return fail(
					'There is no chat to show a card in. Say in your reply which credential you need and that a person can share it with you in Settings → Keychain.',
				)
			}
			try {
				const res = (await apiCall(
					config,
					'POST',
					`/api/sessions/${sessionId}/keychain-access-card`,
					{
						credential_name: args.credential_name,
						...(args.hint ? { hint: args.hint } : {}),
					},
					{ workspaceId: args.workspace_id },
				)) as { already_granted?: boolean }
				if (res.already_granted) {
					return {
						_meta: toolMeta,
						content: [
							{
								type: 'text' as const,
								text: `You already have access to ${args.credential_name}. An API key is in your environment; a login is never there, so type it on your computer with desktop_type using {{keychain:<Name>.username}} and {{keychain:<Name>.password}}. If it does not work, you were started before it was shared, so ask the user to send you a new message.`,
							},
						],
					}
				}
			} catch (err) {
				const status = parseApiErrorStatus(err)
				if (status === 409) {
					return fail(
						'This session has no person in a chat to ask, so no card could be shown. Say in your reply which credential you need and that it can be shared with you in Settings → Keychain.',
					)
				}
				if (status === 404) {
					return fail(
						'No credential with that name exists. Call list_keychain_credentials for the exact names, or request_keychain_credential to ask the user to add a new one.',
					)
				}
				throw err
			}
			return {
				_meta: toolMeta,
				content: [
					{
						type: 'text' as const,
						text: `A card asking to use ${args.credential_name} is now in the chat. The user decides there; you never see the value. End your turn now without a closing message. If they allow it you are restarted with it: an API key is in your environment; a login is never there, so type it on your computer with desktop_type using {{keychain:<Name>.username}} and {{keychain:<Name>.password}}.`,
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'request_integration_access',
		{
			description: tools.request_integration_access.description,
			inputSchema: tools.request_integration_access.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			// A card in the chat; the person allows it there, which sets the same per-agent access
			// as Settings → Integrations. The agent can never widen its own access from here.
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			const toolMeta = meta(
				'request_integration_access',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			const fail = (text: string) => ({
				_meta: toolMeta,
				isError: true,
				content: [{ type: 'text' as const, text }],
			})
			if (!sessionId || !UUID_RE.test(sessionId)) {
				return fail(
					'There is no chat to show a card in. Say in your reply which integration and what level you need; a workspace admin can set it under Settings → Integrations.',
				)
			}
			try {
				const res = (await apiCall(
					config,
					'POST',
					`/api/sessions/${sessionId}/integration-access-card`,
					{
						integration_id: args.integration_id,
						level: args.level,
						...(args.reason ? { reason: args.reason } : {}),
					},
					{ workspaceId: args.workspace_id },
				)) as { already_granted?: boolean }
				if (res.already_granted) {
					return {
						_meta: toolMeta,
						content: [
							{
								type: 'text' as const,
								text: 'You already have that access to this integration. If a call was refused, you were started before it was allowed, so ask the user to send you a new message.',
							},
						],
					}
				}
			} catch (err) {
				const status = parseApiErrorStatus(err)
				if (status === 409) {
					return fail(
						'This session has no person in a chat to ask, so no card could be shown. Say in your reply which integration and what level you need; a workspace admin can set it under Settings → Integrations.',
					)
				}
				if (status === 404) {
					return fail(
						'No connected integration with that id. Call list_integrations for the ids, or connect_integration if it is not connected yet.',
					)
				}
				if (status === 400) {
					return fail(
						'That integration cannot be asked for this way. For a saved key or login use list_keychain_credentials and request_keychain_access. A tool server that runs inside you cannot be limited to reading: ask for read_write.',
					)
				}
				throw err
			}
			return {
				_meta: toolMeta,
				content: [
					{
						type: 'text' as const,
						text: 'A card asking for that access is now in the chat. The user decides there. End your turn now without a closing message. If they allow it you are restarted with the new access.',
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'add_mcp_server',
		{
			description: tools.add_mcp_server.description,
			inputSchema: tools.add_mcp_server.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			// A card in the chat with the server's details; the person adds it there (secrets typed
			// into the card, never through the model), which saves it, gives it to the agent that
			// asked and restarts that session. The agent can never add a server or widen its own
			// access from here.
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			const toolMeta = meta(
				'add_mcp_server',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			const fail = (text: string) => ({
				_meta: toolMeta,
				isError: true,
				content: [{ type: 'text' as const, text }],
			})
			if (!sessionId || !UUID_RE.test(sessionId)) {
				return fail(
					'There is no chat to show a card in. Say in your reply what server you need and how to run it; a person can add it under Settings → Integrations.',
				)
			}
			const { workspace_id: workspaceId, ...card } = args
			try {
				await apiCall(config, 'POST', `/api/sessions/${sessionId}/mcp-server-card`, card, {
					workspaceId,
				})
			} catch (err) {
				const status = parseApiErrorStatus(err)
				if (status === 409) {
					return fail(
						'This session has no person in a chat to ask, so no card could be shown. Say in your reply what server you need and how to run it; a person can add it under Settings → Integrations.',
					)
				}
				if (status === 400) return fail(reasonFromError(err, 'invalid_param'))
				throw err
			}
			return {
				_meta: toolMeta,
				content: [
					{
						type: 'text' as const,
						text: 'A card to add that server is now in the chat, with its details filled in. The user checks it, types any key it needs and presses Add. End your turn now without a closing message. If they add it you are restarted with the server attached.',
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'show_computer',
		{
			description: tools.show_computer.description,
			inputSchema: tools.show_computer.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			// A card in the chat opens the agent's OWN computer; the person acts there and
			// presses Done, which sends the agent a message. A 409 means the session has no
			// human on the other end (autonomous run, or not an agent session at all).
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			const toolMeta = meta(
				'show_computer',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			const fail = (text: string) => ({
				_meta: toolMeta,
				isError: true,
				content: [{ type: 'text' as const, text }],
			})
			if (!sessionId || !UUID_RE.test(sessionId)) {
				return fail(
					'There is no chat to show a card in. Say in your reply what you need the user to do on the computer.',
				)
			}
			try {
				await apiCall(
					config,
					'POST',
					`/api/sessions/${sessionId}/computer-card`,
					{ task: args.task },
					{ workspaceId: args.workspace_id },
				)
			} catch (err) {
				const status = parseApiErrorStatus(err)
				if (status === 409) {
					return fail(
						'This session has no person in a chat to ask, so no card could be shown. Say in your reply what you need the user to do.',
					)
				}
				if (status === 404) {
					return fail(
						'Computers are not available in this workspace, so no card could be shown. Say in your reply what you need the user to do.',
					)
				}
				throw err
			}
			return {
				_meta: toolMeta,
				content: [
					{
						type: 'text' as const,
						text: 'A card with your computer is now in the chat. The user opens it, does what you asked and presses Done. End your turn now without a closing message; they will send you a message when they are done. Then call desktop_screenshot to see what changed before you carry on.',
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'update_integration_access',
		{
			description: tools.update_integration_access.description,
			inputSchema: tools.update_integration_access.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const toolMeta = meta(
				'update_integration_access',
				config,
				(args as { workspace_id?: string }).workspace_id,
			)
			const opts = { workspaceId: args.workspace_id }
			const applied: string[] = []
			const failed: string[] = []
			const run = async (label: string, call: () => Promise<unknown>) => {
				try {
					await call()
					applied.push(label)
				} catch (err) {
					failed.push(`${label}: ${err instanceof Error ? err.message : 'failed'}`)
				}
			}
			if (args.default_agent_access) {
				await run(`default → ${args.default_agent_access}`, () =>
					apiCall(
						config,
						'PUT',
						`/api/integrations/${args.integration_id}/default-access`,
						{ defaultAgentAccess: args.default_agent_access },
						opts,
					),
				)
			}
			for (const entry of args.agent_access ?? []) {
				const path = `/api/integrations/${args.integration_id}/grants/${entry.agent_id}`
				await run(`${entry.agent_id} → ${entry.access}`, () =>
					entry.access === 'default'
						? apiCall(config, 'DELETE', path, undefined, opts)
						: apiCall(config, 'PUT', path, { access: entry.access }, opts),
				)
			}
			const text = [
				applied.length ? `Applied: ${applied.join('; ')}.` : 'Nothing was applied.',
				failed.length ? `Failed: ${failed.join('; ')}.` : '',
				'Applies to sessions started after this.',
			]
				.filter(Boolean)
				.join(' ')
			return {
				_meta: toolMeta,
				...(failed.length && !applied.length ? { isError: true } : {}),
				content: [{ type: 'text' as const, text }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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

			const pagination = resolveListPagination({
				limit: (args as { limit?: number }).limit,
				cursor: (args as { cursor?: string }).cursor,
			})
			// Extensions are derived from workspace settings + registered modules —
			// there's no per-row insert timestamp, so cursor uses the id string and
			// snapshot filtering is skipped. Sort order is stable-by-id.
			const { page: pagedRows, nextCursor } = paginateClientSide({
				rows: result,
				limit: pagination.limit,
				snapshotAt: pagination.snapshotAt,
				order: 'asc',
				cursor: pagination.cursor,
				getSortValue: (row) => row.id,
				getId: (row) => row.id,
				applySnapshotFilter: false,
			})
			const payload = buildListPayload({
				key: 'extensions',
				rows: pagedRows,
				limit: pagination.limit,
				nextCursor,
				total: result.length,
			})
			return {
				_meta: meta('list_extensions', config, (args as { workspace_id?: string }).workspace_id),
				content: [{ type: 'text' as const, text: listText(payload) }],
				structuredContent: payload,
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
					content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
						content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
									text: JSON.stringify(result),
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
					content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
					content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
							text: JSON.stringify({ removed, workspace: result }),
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
					content: [{ type: 'text' as const, text: JSON.stringify(result) }],
				}
			}

			throw new Error(
				`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
			)
		},
	)

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

			// Resolve workspace. Only the API call sits in the try: a bad id thrown below
			// must reach the caller as an error, not be mistaken for a connection problem.
			let workspaces: Array<{ id: string; name: string }>
			try {
				workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
					skipWorkspace: true,
				})) as Array<{ id: string; name: string }>
			} catch {
				const setupSteps =
					config.transport === 'http'
						? "  1. Sign in at https://maskin.io and create a workspace\n  2. Copy your Maskin API key from Settings → API keys and your Workspace ID from Settings → Workspace\n  3. Reconnect Claude with `claude mcp add maskin --transport http --url https://maskin.io/mcp --header 'Authorization: Bearer <YOUR_MASKIN_API_KEY>' --header 'X-Workspace-Id: <YOUR_WORKSPACE_ID>'`\n  4. Run /reload-plugins, then call get_started again"
						: '  1. Call create_actor to get an API key\n  2. Restart with API_KEY set\n  3. Call get_started again'
				return textResponse(
					`👋 Welcome to Maskin!\n\nI can't reach your workspace yet. To finish setup:\n${setupSteps}\n\nOr pass a workspace_id directly if you have one.`,
				)
			}

			const effectiveWsId = args.workspace_id ?? config.defaultWorkspaceId
			const workspace = effectiveWsId
				? workspaces.find((w) => w.id === effectiveWsId)
				: workspaces[0]
			if (effectiveWsId && !workspace) {
				throw new Error(
					`Workspace ${effectiveWsId} not found. Call list_workspaces to see the workspaces this key can access.`,
				)
			}

			if (!workspace) {
				return textResponse(
					'👋 Welcome to Maskin!\n\nNo workspace found on this account. Call create_workspace first with a name, then run get_started again.',
				)
			}

			// INSTALL with no workspace chosen on a multi-workspace account: the install
			// writes to a workspace, so do not guess. The preview below only reads.
			if (args.loop_id && args.confirm && !effectiveWsId && workspaces.length > 1) {
				const workspaceLines = workspaces.map((w) => `  • ${w.name} (id: ${w.id})`)
				return textResponse(
					`This account has more than one workspace, so nothing was installed.\n\n${workspaceLines.join('\n')}\n\nPass workspace_id to choose where to install.`,
				)
			}

			// PREVIEW: list marketplace loops so the user can pick one.
			if (!args.loop_id || !args.confirm) {
				let loops: Array<{
					id: string
					name: string
					description: string
					use_case: string | null
					item_types: string[]
				}> = []
				try {
					const result = (await apiCall(config, 'GET', '/api/marketplace/loops', undefined, {
						skipWorkspace: true,
					})) as {
						loops: Array<{
							id: string
							name: string
							description: string
							use_case: string | null
							item_types: string[]
						}>
					}
					loops = result.loops ?? []
				} catch (err) {
					return textResponse(`❌ Failed to fetch marketplace loops: ${String(err)}`)
				}

				if (loops.length === 0) {
					return textResponse(
						`👋 Welcome to Maskin!\n\nThe marketplace has no loops yet. Once loops are published you'll be able to install them here.\n\nIn the meantime, use the marketplace UI in the app to browse and install loops as they become available.`,
					)
				}

				const loopLines = loops.map((l) => {
					const types = l.item_types.length > 0 ? ` [${l.item_types.join(', ')}]` : ''
					const useCase = l.use_case ? ` · ${l.use_case}` : ''
					return `  • ${l.name}${useCase}${types}\n    ${l.description}\n    id: ${l.id}`
				})

				return textResponse(
					`👋 Welcome to Maskin! Let's set up "${workspace.name}".\n\nAvailable loops:\n\n${loopLines.join('\n\n')}\n\nAsk the user:\n  1. Which loop would they like to install?\n  2. What should the workspace be named? (currently "${workspace.name}")\n\nThen call get_started again with:\n  loop_id: "<id from above>"\n  confirm: true\n  workspace_name: "<name if they want to rename>"`,
				)
			}

			// INSTALL: rename workspace (if requested), then install the loop.
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
			let loopObjectId: string | undefined
			try {
				const result = (await apiCall(
					config,
					'POST',
					'/api/installed-loops',
					{ loopId: args.loop_id, workspaceId: workspace.id },
					{ workspaceId: workspace.id },
				)) as {
					objectId?: string | null
					provisioned?: { actors: number; triggers: number; skills: number }
				}
				loopObjectId = result.objectId ?? undefined
				const p = result.provisioned
				if (p) {
					const parts = [
						p.actors > 0 ? `${p.actors} agent${p.actors === 1 ? '' : 's'}` : '',
						p.triggers > 0 ? `${p.triggers} trigger${p.triggers === 1 ? '' : 's'}` : '',
						p.skills > 0 ? `${p.skills} skill${p.skills === 1 ? '' : 's'}` : '',
					].filter(Boolean)
					installSummary = parts.length > 0 ? `Installed: ${parts.join(', ')}.` : 'Loop installed.'
				}
			} catch (err) {
				return textResponse(`❌ Failed to install loop: ${String(err)}`)
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

			const loopLine = loopObjectId
				? `\n🔁 It's now running as a Loop: ${frontendUrl}/${workspace.id}/loops/${loopObjectId}${magicSuffix}`
				: ''

			return textResponse(
				`✅ Loop installed in workspace "${workspace.name}". ${installSummary}
${loopLine}
🌐 Open the workspace: ${workspaceUrl}
${claudeCredsBlock}`,
			)
		},
	)

	// LinkedIn's tools are NOT registered here. They live on the provider's own
	// MCP server (apps/dev/src/lib/integrations/providers/linkedin-unipile/
	// mcp-server.ts, served at /api/integrations/linkedin-unipile/mcp), the same
	// way Slack's do. They were on this platform server until an agent's tool
	// list showed them whether or not the workspace had connected LinkedIn, with
	// no matching entry in the agent's MCP servers panel to attach or detach.

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

	// The agent a person means rides along as ?agent_id=; agents omit it.
	const desktopPath = (path: string, agentId?: string) =>
		agentId ? `${path}?agent_id=${encodeURIComponent(agentId)}` : path

	// Agent computers. Every tool goes through apps/dev's /api/desktop/*, which
	// applies the `workspace-desktop` flag and workspace membership.
	registerAppTool(
		server,
		'desktop_screenshot',
		{
			description: tools.desktop_screenshot.description,
			inputSchema: tools.desktop_screenshot.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const shot = (await apiCall(
				config,
				'POST',
				desktopPath('/api/desktop/screenshot', args.agent_id),
				{},
				{ workspaceId: args.workspace_id },
			)) as { image_base64: string; mime_type: string; width: number; height: number }
			return {
				_meta: meta('desktop_screenshot', config, args.workspace_id),
				content: [
					{ type: 'image' as const, data: shot.image_base64, mimeType: shot.mime_type },
					{
						type: 'text' as const,
						text: `Desktop screenshot, ${shot.width}x${shot.height} pixels. (0,0) is the top-left.`,
					},
				],
			}
		},
	)

	const desktopInputActions = {
		desktop_click: 'click',
		desktop_move: 'move',
		desktop_drag: 'drag',
		desktop_scroll: 'scroll',
		desktop_type: 'type',
		desktop_key: 'key',
	} as const
	for (const [toolName, action] of Object.entries(desktopInputActions) as Array<
		[keyof typeof desktopInputActions, string]
	>) {
		registerAppTool(
			server,
			toolName,
			{
				description: tools[toolName].description,
				inputSchema: tools[toolName].inputSchema.shape,
				_meta: {},
			},
			async (args: { workspace_id?: string; agent_id?: string } & Record<string, unknown>) => {
				const { workspace_id, agent_id, ...input } = args
				await apiCall(
					config,
					'POST',
					desktopPath('/api/desktop/input', agent_id),
					{ action, ...input },
					{ workspaceId: workspace_id },
				)
				return {
					_meta: meta(toolName, config, workspace_id),
					content: [
						{
							type: 'text' as const,
							text: 'Input sent. Call desktop_screenshot to see the result.',
						},
					],
				}
			},
		)
	}

	registerAppTool(
		server,
		'desktop_run',
		{
			description: tools.desktop_run.description,
			inputSchema: tools.desktop_run.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, agent_id, ...body } = args
			const result = await apiCall(
				config,
				'POST',
				desktopPath('/api/desktop/exec', agent_id),
				body,
				{
					workspaceId: workspace_id,
				},
			)
			return {
				_meta: meta('desktop_run', config, workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	registerAppTool(
		server,
		'desktop_put_file',
		{
			description: tools.desktop_put_file.description,
			inputSchema: tools.desktop_put_file.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, agent_id, ...body } = args
			const result = await apiCall(
				config,
				'POST',
				desktopPath('/api/desktop/put-file', agent_id),
				body,
				{ workspaceId: workspace_id },
			)
			return {
				_meta: meta('desktop_put_file', config, workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	registerAppTool(
		server,
		'desktop_expose_port',
		{
			description: tools.desktop_expose_port.description,
			inputSchema: tools.desktop_expose_port.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const sessionId = config.maskinSessionId ?? process.env.SESSION_ID
			if (!sessionId) {
				return {
					_meta: meta('desktop_expose_port', config, args.workspace_id),
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: 'This only works from inside an agent session: there is no sandbox to reach.',
						},
					],
				}
			}
			const result = (await apiCall(
				config,
				'POST',
				desktopPath('/api/desktop/ports', args.agent_id),
				{ session_id: sessionId, guest_port: args.guest_port },
				{ workspaceId: args.workspace_id },
			)) as { guest_port: number; relay_port: number; url: string }
			return {
				_meta: meta('desktop_expose_port', config, args.workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `Port ${result.guest_port} in your sandbox is open on your computer at ${result.url}. Open that URL in Chromium on your computer (not localhost). To free the slot later, call desktop_close_port with relay_port ${result.relay_port}.`,
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'desktop_list_ports',
		{
			description: tools.desktop_list_ports.description,
			inputSchema: tools.desktop_list_ports.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(
				config,
				'GET',
				desktopPath('/api/desktop/ports', args.agent_id),
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta('desktop_list_ports', config, args.workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	registerAppTool(
		server,
		'desktop_close_port',
		{
			description: tools.desktop_close_port.description,
			inputSchema: tools.desktop_close_port.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(
				config,
				'DELETE',
				desktopPath(`/api/desktop/ports/${args.relay_port}`, args.agent_id),
				undefined,
				{ workspaceId: args.workspace_id },
			)
			return {
				_meta: meta('desktop_close_port', config, args.workspace_id),
				content: [{ type: 'text' as const, text: JSON.stringify(result) }],
			}
		},
	)

	// Expose the collected handlers so `getServerHandlers(server)` (and
	// `createInvokeTool` in ./invoke.ts) can dispatch tools by name without a
	// transport. Set after every registration completes so partial builds are
	// invisible to callers.
	serverHandlers.set(server, handlers)

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
		telemetryEra: 'legacy',
		telemetryProtocolVersion: 'none',
	}

	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('MCP server started (stdio transport)')
}

main().catch(console.error)
