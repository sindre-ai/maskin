import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import './extensions.js'
import { getAllModules, getModuleDefaultSettings } from '@maskin/module-sdk'
import {
	type CustomExtensionEntry,
	WORKSPACE_TEMPLATES,
	type WorkspaceTemplate,
	type WorkspaceTemplateId,
	buildWebAppHref,
} from '@maskin/shared'
import {
	RESOURCE_MIME_TYPE,
	registerAppTool as _registerAppTool,
	registerAppResource,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { deepLink } from './deep-link.js'
import {
	type FormattedResult,
	type FormatterContext,
	formatMutationConfirm,
	formatObjectBatch,
	formatObjectList,
	formatSearchHits,
	formatUnreadDigest,
	formatWorkspaceSummary,
} from './formatters.js'
import {
	MUTATION_TOOL_KINDS,
	type TelemetrySink,
	createDefaultSink,
	measureToolResponse,
	recordMutation,
	recordToolCall,
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
	if (config.webAppBaseUrl) m.webAppBaseUrl = config.webAppBaseUrl.replace(/\/$/, '')
	const ws = workspaceId ?? config.defaultWorkspaceId
	if (ws) m.workspaceId = ws
	return m
}

/**
 * Build the formatter context for the current tool invocation. Resolves the
 * effective workspace id (caller-passed → DEFAULT_WORKSPACE_ID) and threads the
 * web-app base URL so every deep link the formatter emits routes through the
 * Task 1 click-tracking redirect at `<base>/r/...`.
 */
function buildFormatterContext(
	toolName: string,
	config: McpConfig,
	workspaceId: string | undefined,
): FormatterContext {
	return {
		workspaceId: workspaceId ?? config.defaultWorkspaceId,
		tool: toolName,
		baseUrl: config.webAppBaseUrl,
	}
}

/**
 * MCP `structuredContent` must be a JSON object (`Record<string, unknown>`).
 * Formatter outputs can be arrays (lists, search hits, batches) — wrap those in
 * `{ items: ... }` so the SDK accepts the payload without losing the raw JSON.
 * Object payloads pass through unchanged; arrays become `{ items: [...] }`,
 * which matches the convention used by every list-shaped tool's wire format.
 */
function asStructuredContent(value: unknown): { [k: string]: unknown } {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		return value as { [k: string]: unknown }
	}
	return { items: value }
}

/**
 * Wrap a `FormattedResult` into the MCP `CallToolResult` shape: lean markdown
 * in `content[0].text`, raw JSON in `structuredContent`, `_meta` carrying the
 * tool name + workspace for the rich-render card runtime.
 */
function leanReply(
	toolName: string,
	formatted: FormattedResult,
	config: McpConfig,
	workspaceId: string | undefined,
) {
	return {
		_meta: meta(toolName, config, workspaceId),
		content: [{ type: 'text' as const, text: formatted.content }],
		structuredContent: asStructuredContent(formatted.structuredContent),
	}
}

const GENERIC_LIST_LIMIT = 25

/**
 * Render an array of API rows as a lean `FormattedResult` for tools without a
 * purpose-built formatter (actors, files, triggers, sessions, …). Header names
 * the count and links into the appropriate maskin.app surface; up to 25 rows
 * follow as one-liners produced by the supplied `row` renderer. Empty lists
 * render as a single italic "no X." line. Caller supplies the row count noun
 * (singular `label`) and the deep-link spec so click telemetry attributes back
 * to the originating tool.
 */
function formatGenericList<T>(
	rows: T[],
	opts: {
		label: string
		row: (item: T) => string
		linkInput: Parameters<typeof deepLink>[0]
		linkText?: string
		emptyText?: string
	},
): FormattedResult {
	const count = rows.length
	const noun = count === 1 ? opts.label : `${opts.label}s`
	const linkText = opts.linkText ?? 'open in Maskin'
	const url = deepLink(opts.linkInput)
	const header = `**${count} ${noun}** — [${linkText}](${url})`
	if (count === 0) {
		const empty = opts.emptyText ?? `_No ${noun}._`
		return { content: `${header}\n\n${empty}`, structuredContent: { items: rows } }
	}
	const shown = rows.slice(0, GENERIC_LIST_LIMIT)
	const lines = [header, ...shown.map(opts.row)]
	if (rows.length > shown.length) lines.push(`…and ${rows.length - shown.length} more`)
	return { content: lines.join('\n'), structuredContent: { items: rows } }
}

/**
 * Single-record `FormattedResult` for tools that return one row without a
 * matching formatter (`get_actor`, `get_file`, `get_session`, `get_workspace_skill`,
 * `get_llm_api_keys`, …). `title` is the H4 headline, `meta` the italic
 * sub-line; both can be empty strings to skip rendering.
 */
function formatGenericRecord(
	record: unknown,
	opts: {
		title: string
		meta?: string
		linkInput: Parameters<typeof deepLink>[0]
	},
): FormattedResult {
	const url = deepLink(opts.linkInput)
	const lines: string[] = [`#### [${opts.title}](${url})`]
	if (opts.meta) lines.push(`_${opts.meta}_`)
	return {
		content: lines.join('\n'),
		structuredContent: asStructuredContent(record),
	}
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
} as const

const CSP = {
	'font-src': ['https://fonts.gstatic.com'],
	'style-src': ['https://fonts.googleapis.com'],
} as const

async function apiCall(
	config: McpConfig,
	method: string,
	path: string,
	body?: unknown,
	options?: {
		skipAuth?: boolean
		skipWorkspace?: boolean
		workspaceId?: string
		idempotencyKey?: string
	},
): Promise<unknown> {
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
	if (options?.idempotencyKey) {
		headers['Idempotency-Key'] = options.idempotencyKey
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

	return response.json()
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

/**
 * Merge default settings from all enabled modules into the given settings.
 * Existing keys win — module defaults only fill in types not already specified.
 * Used when applying a template so that module-provided types (e.g. CRM contact/company)
 * pick up their statuses/display_names/field_definitions without inline duplication.
 */
export function mergeEnabledModuleDefaults(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const enabledModules = Array.isArray(settings.enabled_modules)
		? (settings.enabled_modules as string[])
		: ['work']

	const displayNames = { ...((settings.display_names ?? {}) as Record<string, string>) }
	const statuses = { ...((settings.statuses ?? {}) as Record<string, string[]>) }
	const fieldDefs = { ...((settings.field_definitions ?? {}) as Record<string, unknown[]>) }
	const relTypes = new Set<string>(
		Array.isArray(settings.relationship_types) ? (settings.relationship_types as string[]) : [],
	)

	for (const moduleId of enabledModules) {
		const defaults = getModuleDefaultSettings(moduleId)
		if (!defaults) continue

		if (defaults.display_names) {
			for (const [type, name] of Object.entries(defaults.display_names)) {
				if (!(type in displayNames)) displayNames[type] = name
			}
		}
		if (defaults.statuses) {
			for (const [type, sts] of Object.entries(defaults.statuses)) {
				if (!(type in statuses)) statuses[type] = sts
			}
		}
		if (defaults.field_definitions) {
			for (const [type, fields] of Object.entries(defaults.field_definitions)) {
				if (!(type in fieldDefs)) fieldDefs[type] = fields
			}
		}
		if (defaults.relationship_types) {
			for (const rt of defaults.relationship_types) relTypes.add(rt)
		}
	}

	return {
		...settings,
		display_names: displayNames,
		statuses: statuses,
		field_definitions: fieldDefs,
		relationship_types: [...relTypes],
	}
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
	const baseUrl = config.webAppBaseUrl?.replace(/\/$/, '')
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
 * Reads from `structuredContent` (the lean-results JSON payload added in Task 4)
 * since `content[0].text` is now markdown, not JSON. Arrays of per-target
 * results live under `structuredContent.items`; single-record payloads are the
 * object itself. Defaults to `false` for unrecognised shapes — over-counting
 * biases the bet's "20% of sessions include at least one mutation" metric
 * upward, so unknown responses are treated as "not a confirmed mutation".
 */
function isSuccessfulMutationResponse(response: unknown): boolean {
	if (!response || typeof response !== 'object') return false
	if ((response as { isError?: unknown }).isError === true) return false
	const sc = (response as { structuredContent?: unknown }).structuredContent
	if (!sc || typeof sc !== 'object') return false
	// Per-target aggregation (update_objects-style) — array under `items`.
	const items = (sc as { items?: unknown }).items
	if (Array.isArray(items)) {
		return items.some((entry) => {
			if (!entry || typeof entry !== 'object') return false
			return (entry as { success?: unknown }).success === true
		})
	}
	// Graph response (`create_objects`): the full graph payload replaces the
	// items wrapper, so check the `nodes` array as the success signal. Without
	// this branch the most-common write tool's telemetry silently drops to zero.
	const nodes = (sc as { nodes?: unknown }).nodes
	if (Array.isArray(nodes)) return nodes.length > 0
	// Single-record payload.
	const obj = sc as { success?: unknown; error?: unknown; id?: unknown; skipped?: unknown }
	if (obj.success === true) return true
	if (obj.success === false) return false
	// No explicit success flag — count if the payload has no `error` and looks
	// like a record (has an `id`). Skipped no-ops report `skipped: true`.
	if (obj.skipped === true) return false
	return obj.error == null && typeof obj.id === 'string'
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

			const sizes = measureToolResponse(response)
			recordToolCall(telemetrySink, telemetryTarget, {
				tool_name: name,
				has_rich_render: responseHasRichRender,
				duration_ms: Date.now() - start,
				workspace_id: extractWorkspaceId(args),
				content_bytes: sizes.content_bytes,
				content_tokens: sizes.content_tokens,
				structured_content_bytes: sizes.structured_content_bytes,
			})

			if (mutationKind && isSuccessfulMutationResponse(response)) {
				recordMutation(telemetrySink, telemetryTarget, {
					tool_name: name,
					mutation_kind: mutationKind,
					object_type: extractObjectType(name, args),
					workspace_id: extractWorkspaceId(args),
				})
			}

			return response
		}

		// biome-ignore lint/suspicious/noExplicitAny: handler signature varies by inputSchema presence; the wrapper is a pure pass-through so we forward as-is.
		return _registerAppTool(s, name, definition, wrappedHandler as any)
		// biome-ignore lint/suspicious/noExplicitAny: see comment above.
	}) as any as typeof _registerAppTool

	// ─── Register UI resources ─────────────────────────────────
	for (const [name, uri] of Object.entries(UI_RESOURCES)) {
		registerAppResource(server, `${name}-ui`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
			console.log(`[MCP] Resource read requested: ${uri} (${name}.html)`)
			return {
				contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: loadHtml(config, `${name}.html`) }],
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

			const responseBody = fileAttachments.length
				? { ...graphResult, file_attachments: fileAttachments }
				: graphResult

			const ctx = buildFormatterContext('create_objects', config, workspace_id)
			const createdNodes = graphResult.nodes ?? []
			const confirmResults: Parameters<typeof formatMutationConfirm>[0]['results'] =
				createdNodes.map((n) => ({
					type: n.type,
					id: n.id,
					success: true,
					result: { id: n.id, type: n.type },
				}))
			for (const a of fileAttachments) {
				confirmResults.push({
					type: a.type,
					id: a.id,
					success: a.success,
					error: a.error,
				})
			}
			return {
				...leanReply(
					'create_objects',
					formatMutationConfirm(
						{
							verb: `Created ${createdNodes.length} object${createdNodes.length === 1 ? '' : 's'}`,
							results: confirmResults,
						},
						ctx,
					),
					config,
					workspace_id,
				),
				// Override structuredContent so callers still get the full graph response
				// (nodes + edges + per-file attachments) instead of just the verbal
				// confirm list.
				structuredContent: asStructuredContent(responseBody),
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
			const { workspace_id } = args
			const results = await Promise.all(
				args.ids.map(async (id) => {
					try {
						const result = await apiCall(config, 'GET', `/api/objects/${id}/graph`, undefined, {
							workspaceId: workspace_id,
						})
						return {
							id,
							success: true,
							result: result as Parameters<typeof formatObjectBatch>[0][number]['result'],
						}
					} catch (error) {
						return { id, success: false, error: String(error) }
					}
				}),
			)
			const ctx = buildFormatterContext('get_objects', config, workspace_id)
			return leanReply('get_objects', formatObjectBatch(results, ctx), config, workspace_id)
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
								out.push({ type: 'object', id, success: true, result })
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

			const ctx = buildFormatterContext('update_objects', config, workspace_id)
			// `results` carries `result: unknown` from the API call, which the
			// mutation-confirm formatter's stricter shape rejects — strip it before
			// handing off. The full untyped payload still flows through
			// structuredContent below.
			const confirmResults: Parameters<typeof formatMutationConfirm>[0]['results'] = results.map(
				(r) => ({
					type: r.type,
					id: r.id,
					success: r.success,
					skipped: r.skipped,
					error: r.error,
				}),
			)
			return {
				...leanReply(
					'update_objects',
					formatMutationConfirm({ verb: 'Updated objects', results: confirmResults }, ctx),
					config,
					workspace_id,
				),
				structuredContent: asStructuredContent({ items: results }),
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
			const ctx = buildFormatterContext('delete_object', config, args.workspace_id)
			return leanReply(
				'delete_object',
				formatMutationConfirm(
					{
						verb: 'Deleted object',
						results: [
							{
								type: 'object',
								id: args.id,
								success: true,
								result: result as Record<string, unknown>,
							},
						],
					},
					ctx,
				),
				config,
				args.workspace_id,
			)
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
			const params = new URLSearchParams()
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = (await apiCall(config, 'GET', `/api/objects?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Parameters<typeof formatObjectList>[0]
			const ctx = buildFormatterContext('list_objects', config, args.workspace_id)
			return leanReply('list_objects', formatObjectList(result, ctx), config, args.workspace_id)
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
			const params = new URLSearchParams()
			params.set('q', args.q)
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = (await apiCall(config, 'GET', `/api/objects/search?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Parameters<typeof formatObjectList>[0]
			const ctx = buildFormatterContext('search_objects', config, args.workspace_id)
			return leanReply(
				'search_objects',
				formatSearchHits({ q: args.q, hits: result, type: args.type }, ctx),
				config,
				args.workspace_id,
			)
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
			const params = new URLSearchParams()
			if (args.object_id) params.set('object_id', args.object_id)
			if (args.source_id) params.set('source_id', args.source_id)
			if (args.target_id) params.set('target_id', args.target_id)
			if (args.type) params.set('type', args.type)
			const result = (await apiCall(config, 'GET', `/api/relationships?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Array<{
				id: string
				sourceTitle?: string | null
				targetTitle?: string | null
				type: string
				sourceId: string
				targetId: string
			}>
			const ctx = buildFormatterContext('list_relationships', config, args.workspace_id)
			return leanReply(
				'list_relationships',
				formatGenericList(result, {
					label: 'relationship',
					row: (r) => {
						const s = r.sourceTitle?.trim() || r.sourceId.slice(0, 8)
						const t = r.targetTitle?.trim() || r.targetId.slice(0, 8)
						return `- ${s} → \`${r.type}\` → ${t}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'workspace',
						tool: 'list_relationships',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				args.workspace_id,
			)
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
			const ctx = buildFormatterContext('delete_relationship', config, args.workspace_id)
			return leanReply(
				'delete_relationship',
				formatMutationConfirm(
					{
						verb: 'Deleted relationship',
						results: [
							{
								type: 'relationship',
								id: args.id,
								success: true,
								result: result as Record<string, unknown>,
							},
						],
					},
					ctx,
				),
				config,
				args.workspace_id,
			)
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

			const ctx = buildFormatterContext('create_actor', config, workspace_id)
			const actorId = typeof result.id === 'string' ? result.id : undefined
			return {
				...leanReply(
					'create_actor',
					formatMutationConfirm(
						{
							verb: 'Created actor',
							results: [
								{
									type: 'actor',
									id: actorId,
									success: true,
									result: { id: actorId, type: 'actor' } as Record<string, unknown>,
								},
							],
							section: targetWorkspace ? 'members' : undefined,
						},
						ctx,
					),
					config,
					workspace_id,
				),
				structuredContent: asStructuredContent(result),
			}
		},
	)

	registerAppTool(
		server,
		'list_actors',
		{
			description: tools.list_actors.description,
			inputSchema: tools.list_actors.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const result = (
				args.workspace_id
					? await apiCall(config, 'GET', '/api/actors', undefined, {
							workspaceId: args.workspace_id,
						})
					: await apiCall(config, 'GET', '/api/actors', undefined, { skipWorkspace: true })
			) as Array<{
				id: string
				type: 'human' | 'agent'
				name: string
				email?: string | null
				role?: string
			}>
			const ctx = buildFormatterContext('list_actors', config, args.workspace_id)
			return leanReply(
				'list_actors',
				formatGenericList(result, {
					label: 'actor',
					row: (a) => {
						const url = deepLink({
							workspaceId: ctx.workspaceId,
							kind: 'actor',
							id: a.id,
							tool: 'list_actors',
							baseUrl: ctx.baseUrl,
						})
						const tag = a.email ? `${a.type} • ${a.email}` : a.type
						return `- [${a.name || a.id.slice(0, 8)}](${url}) — ${tag}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'actor',
						tool: 'list_actors',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				args.workspace_id,
			)
		},
	)

	registerAppTool(
		server,
		'get_actor',
		{
			description: tools.get_actor.description,
			inputSchema: tools.get_actor.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', `/api/actors/${args.id}`, undefined, {
				skipWorkspace: true,
			})) as { id: string; name?: string | null; type: 'human' | 'agent'; email?: string | null }
			// get_actor's schema doesn't declare `workspace_id` (actors aren't
			// workspace-scoped), so we read it through a structural cast for the
			// deep-link context — same pattern the surrounding handlers use.
			const wsHint = (args as { workspace_id?: string }).workspace_id
			const ctx = buildFormatterContext('get_actor', config, wsHint)
			return leanReply(
				'get_actor',
				formatGenericRecord(result, {
					title: result.name?.trim() || `${result.type} ${result.id.slice(0, 8)}`,
					meta: result.email ? `${result.type} • ${result.email}` : result.type,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'actor',
						id: result.id,
						tool: 'get_actor',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				wsHint,
			)
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
			const { id, ...body } = args
			const result = (await apiCall(config, 'PATCH', `/api/actors/${id}`, body, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			const wsHint = (args as { workspace_id?: string }).workspace_id
			const ctx = buildFormatterContext('update_actor', config, wsHint)
			return {
				...leanReply(
					'update_actor',
					formatMutationConfirm(
						{
							verb: 'Updated actor',
							results: [{ type: 'actor', id, success: true, result: { id, type: 'actor' } }],
						},
						ctx,
					),
					config,
					wsHint,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'POST', `/api/actors/${args.id}/api-keys`, undefined, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			const wsHint = (args as { workspace_id?: string }).workspace_id
			const ctx = buildFormatterContext('regenerate_api_key', config, wsHint)
			return {
				...leanReply(
					'regenerate_api_key',
					formatMutationConfirm(
						{
							verb: 'Rotated API key',
							results: [{ type: 'actor', id: args.id, success: true, result: { id: args.id } }],
						},
						ctx,
					),
					config,
					wsHint,
				),
				// The new API key only ever exists in this response — preserve the full
				// payload so callers can still read `apiKey` from structuredContent.
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'POST', '/api/workspaces', args, {
				skipWorkspace: true,
			})) as { id?: string; name?: string }
			const wsId = result.id
			const ctx = buildFormatterContext('create_workspace', config, wsId)
			return {
				...leanReply(
					'create_workspace',
					formatMutationConfirm(
						{
							verb: 'Created workspace',
							// `formatMutationConfirm` links to the first successful object via
							// its `object` deep-link; for workspaces we want the workspace
							// link instead, so we leave `results[0].result.id` unset.
							results: [{ type: 'workspace', id: result.id, success: true }],
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'PATCH', `/api/workspaces/${id}`, body, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('update_workspace', config, id)
			return {
				...leanReply(
					'update_workspace',
					formatMutationConfirm(
						{
							verb: 'Updated workspace',
							results: [{ type: 'workspace', id, success: true }],
						},
						ctx,
					),
					config,
					id,
				),
				structuredContent: asStructuredContent(result),
			}
		},
	)

	registerAppTool(
		server,
		'list_workspaces',
		{
			description: tools.list_workspaces.description,
			inputSchema: tools.list_workspaces.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async () => {
			const result = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
				skipWorkspace: true,
			})) as Array<{ id: string; name: string }>
			// `list_workspaces` is the only tool that may operate without a default
			// workspace (it's how callers find one). Skip the formatter context, which
			// would otherwise blow up on an empty workspaceId. The header link goes
			// to the first workspace in the list, falling back to a relative path.
			const fallback = result[0]
			const url = fallback
				? deepLink({
						workspaceId: fallback.id,
						kind: 'workspace',
						tool: 'list_workspaces',
						baseUrl: config.webAppBaseUrl,
					})
				: undefined
			const header = url
				? `**${result.length} workspace${result.length === 1 ? '' : 's'}** — [open in Maskin](${url})`
				: `**${result.length} workspace${result.length === 1 ? '' : 's'}**`
			const rows = result.slice(0, GENERIC_LIST_LIMIT).map((w) => {
				const link = deepLink({
					workspaceId: w.id,
					kind: 'workspace',
					tool: 'list_workspaces',
					baseUrl: config.webAppBaseUrl,
				})
				return `- [${w.name}](${link})`
			})
			const more =
				result.length > GENERIC_LIST_LIMIT
					? [`…and ${result.length - GENERIC_LIST_LIMIT} more`]
					: []
			const content =
				result.length === 0
					? `${header}\n\n_No workspaces._`
					: [header, ...rows, ...more].join('\n')
			return leanReply(
				'list_workspaces',
				{ content, structuredContent: { items: result } },
				config,
				undefined,
			)
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
				typeSchemas[t] = {
					display_name: displayNames[t] ?? t,
					statuses: statuses[t] ?? [],
					fields: fieldDefinitions[t] ?? [],
				}
			}

			schema.types = typeSchemas

			const ctx = buildFormatterContext('get_workspace_schema', config, workspace.id)
			return leanReply(
				'get_workspace_schema',
				formatWorkspaceSummary(
					{
						workspace_id: workspace.id,
						workspace_name: workspace.name,
						relationship_types: relationshipTypes,
						types: typeSchemas as Record<
							string,
							{
								display_name?: string
								statuses?: string[]
								fields?: Array<{ name: string; type: string }>
							}
						>,
					},
					ctx,
				),
				config,
				workspace.id,
			)
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
			const result = (await apiCall(
				config,
				'POST',
				`/api/workspaces/${args.workspace_id}/members`,
				{ actor_id: args.actor_id, role: args.role },
				{ skipWorkspace: true },
			)) as Record<string, unknown>
			const ctx = buildFormatterContext('add_workspace_member', config, args.workspace_id)
			return {
				...leanReply(
					'add_workspace_member',
					formatMutationConfirm(
						{
							verb: 'Added member',
							results: [{ type: 'member', id: args.actor_id, success: true }],
							section: 'members',
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const ctx = buildFormatterContext('create_workspace_field', config, wsId)
			return {
				...leanReply(
					'create_workspace_field',
					formatMutationConfirm(
						{
							verb: `Created field "${args.name}"`,
							results: [{ type: 'field', id: args.name, success: true }],
							section: 'objects',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent({
					workspace_id: wsId,
					type: args.type,
					field: created,
				}),
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
			const ctx = buildFormatterContext('update_workspace_field', config, wsId)
			return {
				...leanReply(
					'update_workspace_field',
					formatMutationConfirm(
						{
							verb: `Updated field "${args.name}"`,
							results: [{ type: 'field', id: renamed, success: true }],
							section: 'objects',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent({
					workspace_id: wsId,
					type: args.type,
					field: updated,
				}),
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
			const ctx = buildFormatterContext('delete_workspace_field', config, wsId)
			return {
				...leanReply(
					'delete_workspace_field',
					formatMutationConfirm(
						{
							verb: `Deleted field "${args.name}"`,
							results: [{ type: 'field', id: args.name, success: true }],
							section: 'objects',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent({
					workspace_id: wsId,
					type: args.type,
					deleted: args.name,
					success: true,
				}),
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
			const ctx = buildFormatterContext('add_workspace_enum_value', config, wsId)
			return {
				...leanReply(
					'add_workspace_enum_value',
					formatMutationConfirm(
						{
							verb: `Added enum value "${args.value}"`,
							results: [{ type: 'enum_value', id: args.value, success: true }],
							section: 'objects',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent({
					workspace_id: wsId,
					type: args.type,
					field: updated,
				}),
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
			const ctx = buildFormatterContext('remove_workspace_enum_value', config, wsId)
			return {
				...leanReply(
					'remove_workspace_enum_value',
					formatMutationConfirm(
						{
							verb: `Removed enum value "${args.value}"`,
							results: [{ type: 'enum_value', id: args.value, success: true }],
							section: 'objects',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent({
					workspace_id: wsId,
					type: args.type,
					field: updated,
				}),
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
			const result = (await apiCall(config, 'GET', `/api/workspaces/${wsId}/skills`, undefined, {
				workspaceId: wsId,
			})) as Array<{ name: string; description?: string | null }>
			const ctx = buildFormatterContext('list_workspace_skills', config, wsId)
			return leanReply(
				'list_workspace_skills',
				formatGenericList(result, {
					label: 'skill',
					row: (s) => `- \`${s.name}\``,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'settings',
						section: 'skills',
						tool: 'list_workspace_skills',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				wsId,
			)
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
			const result = (await apiCall(
				config,
				'GET',
				`/api/workspaces/${wsId}/skills/${encodeURIComponent(args.name)}`,
				undefined,
				{ workspaceId: wsId },
			)) as { name: string; description?: string | null; content?: string }
			const ctx = buildFormatterContext('get_workspace_skill', config, wsId)
			return leanReply(
				'get_workspace_skill',
				formatGenericRecord(result, {
					title: result.name,
					meta: result.description ?? undefined,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'settings',
						section: 'skills',
						tool: 'get_workspace_skill',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				wsId,
			)
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
			const result = (await apiCall(
				config,
				'POST',
				`/api/workspaces/${wsId}/skills`,
				{ name: args.name, content: args.content },
				{ workspaceId: wsId },
			)) as Record<string, unknown>
			const ctx = buildFormatterContext('create_workspace_skill', config, wsId)
			return {
				...leanReply(
					'create_workspace_skill',
					formatMutationConfirm(
						{
							verb: `Created skill "${args.name}"`,
							results: [{ type: 'skill', id: args.name, success: true }],
							section: 'skills',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(
				config,
				'PUT',
				`/api/workspaces/${wsId}/skills/${encodeURIComponent(args.name)}`,
				{ content: args.content },
				{ workspaceId: wsId },
			)) as Record<string, unknown>
			const ctx = buildFormatterContext('update_workspace_skill', config, wsId)
			return {
				...leanReply(
					'update_workspace_skill',
					formatMutationConfirm(
						{
							verb: `Updated skill "${args.name}"`,
							results: [{ type: 'skill', id: args.name, success: true }],
							section: 'skills',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(
				config,
				'DELETE',
				`/api/workspaces/${wsId}/skills/${encodeURIComponent(args.name)}`,
				undefined,
				{ workspaceId: wsId },
			)) as Record<string, unknown>
			const ctx = buildFormatterContext('delete_workspace_skill', config, wsId)
			return {
				...leanReply(
					'delete_workspace_skill',
					formatMutationConfirm(
						{
							verb: `Deleted skill "${args.name}"`,
							results: [{ type: 'skill', id: args.name, success: true }],
							section: 'skills',
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(
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
			)) as { id?: string }
			const ctx = buildFormatterContext('create_file', config, wsId)
			return {
				...leanReply(
					'create_file',
					formatMutationConfirm(
						{
							verb: `Created file "${args.name}"`,
							results: [{ type: 'file', id: result.id, success: true }],
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const params = new URLSearchParams()
			if (args.q) params.set('q', args.q)
			if (args.limit !== undefined) params.set('limit', String(args.limit))
			if (args.offset !== undefined) params.set('offset', String(args.offset))
			const qs = params.toString()
			const result = (await apiCall(config, 'GET', `/api/files${qs ? `?${qs}` : ''}`, undefined, {
				workspaceId: wsId,
			})) as Array<{ id: string; name: string; mimeType?: string | null; sizeBytes?: number }>
			const ctx = buildFormatterContext('list_files', config, wsId)
			return leanReply(
				'list_files',
				formatGenericList(result, {
					label: 'file',
					row: (f) => {
						const mime = f.mimeType ? ` • ${f.mimeType}` : ''
						return `- \`${f.name}\`${mime}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'workspace',
						tool: 'list_files',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				wsId,
			)
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
			const result = (await apiCall(config, 'GET', `/api/files/${args.id}`, undefined, {
				workspaceId: wsId,
			})) as { id: string; name?: string; mimeType?: string | null; sizeBytes?: number }
			const ctx = buildFormatterContext('get_file', config, wsId)
			const mime = result.mimeType ?? 'unknown type'
			const size =
				typeof result.sizeBytes === 'number' ? `${(result.sizeBytes / 1024).toFixed(1)} KB` : ''
			return leanReply(
				'get_file',
				formatGenericRecord(result, {
					title: result.name?.trim() || `File ${result.id.slice(0, 8)}`,
					meta: size ? `${mime} • ${size}` : mime,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'workspace',
						tool: 'get_file',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				wsId,
			)
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
			const result = (await apiCall(config, 'PATCH', `/api/files/${args.id}`, body, {
				workspaceId: wsId,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('update_file', config, wsId)
			return {
				...leanReply(
					'update_file',
					formatMutationConfirm(
						{
							verb: 'Updated file',
							results: [{ type: 'file', id: args.id, success: true }],
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'DELETE', `/api/files/${args.id}`, undefined, {
				workspaceId: wsId,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('delete_file', config, wsId)
			return {
				...leanReply(
					'delete_file',
					formatMutationConfirm(
						{
							verb: 'Deleted file',
							results: [{ type: 'file', id: args.id, success: true }],
						},
						ctx,
					),
					config,
					wsId,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'GET', `/api/events/history?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Array<{
				id?: number
				action?: string
				entityType?: string
				entityId?: string
				description?: string | null
				createdAt?: string | null
			}>
			const ctx = buildFormatterContext('get_events', config, args.workspace_id)
			return leanReply(
				'get_events',
				formatGenericList(result, {
					label: 'event',
					row: (e) => {
						const desc =
							e.description?.trim() || `${e.action ?? 'event'} ${e.entityType ?? ''}`.trim()
						const when = e.createdAt ? ` _(${e.createdAt})_` : ''
						return `- ${desc}${when}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'unread',
						tool: 'get_events',
						baseUrl: ctx.baseUrl,
					},
					linkText: 'open activity',
				}),
				config,
				args.workspace_id,
			)
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
			const result = (await apiCall(config, 'GET', `/api/events/history?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Array<{
				id?: number
				actorId?: string
				data?: { content?: string }
				createdAt?: string | null
			}>
			const ctx = buildFormatterContext('get_comments', config, args.workspace_id)
			return leanReply(
				'get_comments',
				formatGenericList(result, {
					label: 'comment',
					row: (c) => {
						const text = c.data?.content?.replace(/\s+/g, ' ').trim() ?? ''
						const snippet = text.length > 100 ? `${text.slice(0, 99)}…` : text || '(empty)'
						const author = c.actorId ? c.actorId.slice(0, 8) : 'unknown'
						return `- **${author}**: ${snippet}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'comments',
						id: args.entity_id,
						tool: 'get_comments',
						baseUrl: ctx.baseUrl,
					},
					linkText: 'open thread',
				}),
				config,
				args.workspace_id,
			)
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
			const result = (await apiCall(config, 'POST', '/api/events', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('create_comment', config, workspace_id)
			return {
				...leanReply(
					'create_comment',
					formatMutationConfirm(
						{
							verb: 'Posted comment',
							// Link to the object the comment was posted on, not the event itself.
							results: [
								{
									type: 'object',
									id: args.entity_id,
									success: true,
									result: { id: args.entity_id, type: 'object' } as Record<string, unknown>,
								},
							],
						},
						ctx,
					),
					config,
					workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'POST', '/api/triggers', body, {
				workspaceId: workspace_id,
			})) as { id?: string; name?: string }
			const ctx = buildFormatterContext('create_trigger', config, workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: result.id ? 'trigger' : 'workspace',
				id: result.id,
				tool: 'create_trigger',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('create_trigger', config, workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `✅ **Created trigger${args.name ? ` "${args.name}"` : ''}** — [open in Maskin](${link})`,
					},
				],
				structuredContent: asStructuredContent(result),
			}
		},
	)

	registerAppTool(
		server,
		'list_triggers',
		{
			description: tools.list_triggers.description,
			inputSchema: tools.list_triggers.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', '/api/triggers', undefined, {
				workspaceId: args.workspace_id,
			})) as Array<{ id: string; name: string; type: string; enabled: boolean }>
			const ctx = buildFormatterContext('list_triggers', config, args.workspace_id)
			return leanReply(
				'list_triggers',
				formatGenericList(result, {
					label: 'trigger',
					row: (t) => {
						const url = deepLink({
							workspaceId: ctx.workspaceId,
							kind: 'trigger',
							id: t.id,
							tool: 'list_triggers',
							baseUrl: ctx.baseUrl,
						})
						const state = t.enabled ? 'enabled' : 'disabled'
						return `- [${t.name || `Trigger ${t.id.slice(0, 8)}`}](${url}) — ${t.type} • ${state}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'trigger',
						tool: 'list_triggers',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				args.workspace_id,
			)
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
			const result = (await apiCall(config, 'PATCH', `/api/triggers/${id}`, body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('update_trigger', config, workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'trigger',
				id,
				tool: 'update_trigger',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('update_trigger', config, workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `✅ **Updated trigger** — [open in Maskin](${link})`,
					},
				],
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'DELETE', `/api/triggers/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('delete_trigger', config, args.workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'trigger',
				tool: 'delete_trigger',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('delete_trigger', config, args.workspace_id),
				content: [
					{ type: 'text' as const, text: `✅ **Deleted trigger** — [open in Maskin](${link})` },
				],
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'POST', '/api/subscriptions', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('subscribe', config, workspace_id)
			return {
				...leanReply(
					'subscribe',
					formatMutationConfirm(
						{
							verb: 'Subscribed',
							results: [
								{
									type: args.entity_type,
									id: args.entity_id,
									success: true,
									result:
										args.entity_type === 'object'
											? ({ id: args.entity_id, type: 'object' } as Record<string, unknown>)
											: undefined,
								},
							],
						},
						ctx,
					),
					config,
					workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'DELETE', '/api/subscriptions', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('unsubscribe', config, workspace_id)
			return {
				...leanReply(
					'unsubscribe',
					formatMutationConfirm(
						{
							verb: 'Unsubscribed',
							results: [
								{
									type: args.entity_type,
									id: args.entity_id,
									success: true,
									result:
										args.entity_type === 'object'
											? ({ id: args.entity_id, type: 'object' } as Record<string, unknown>)
											: undefined,
								},
							],
						},
						ctx,
					),
					config,
					workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(
				config,
				'GET',
				`/api/subscriptions/subscribers?${params}`,
				undefined,
				{ workspaceId: args.workspace_id },
			)) as Array<{ actorId: string; name?: string | null; email?: string | null }>
			const ctx = buildFormatterContext('list_subscribers', config, args.workspace_id)
			return leanReply(
				'list_subscribers',
				formatGenericList(result, {
					label: 'subscriber',
					row: (s) =>
						`- ${s.name?.trim() || s.actorId.slice(0, 8)}${s.email ? ` • ${s.email}` : ''}`,
					linkInput:
						args.entity_type === 'object'
							? {
									workspaceId: ctx.workspaceId,
									kind: 'object',
									id: args.entity_id,
									tool: 'list_subscribers',
									baseUrl: ctx.baseUrl,
								}
							: {
									workspaceId: ctx.workspaceId,
									kind: 'workspace',
									tool: 'list_subscribers',
									baseUrl: ctx.baseUrl,
								},
				}),
				config,
				args.workspace_id,
			)
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
			const result = (await apiCall(config, 'POST', '/api/subscriptions/read', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('mark_read', config, workspace_id)
			return {
				...leanReply(
					'mark_read',
					formatMutationConfirm(
						{
							verb: 'Marked read',
							results: [
								{
									type: args.entity_type,
									id: args.entity_id,
									success: true,
									result:
										args.entity_type === 'object'
											? ({ id: args.entity_id, type: 'object' } as Record<string, unknown>)
											: undefined,
								},
							],
						},
						ctx,
					),
					config,
					workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'GET', path, undefined, {
				workspaceId: args.workspace_id,
			})) as Parameters<typeof formatUnreadDigest>[0]['items']
			const ctx = buildFormatterContext('list_unread', config, args.workspace_id)
			return leanReply(
				'list_unread',
				formatUnreadDigest({ items: result }, ctx),
				config,
				args.workspace_id,
			)
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
			})) as SessionRow & { status?: string }
			const enriched = await enrichSessionActorName(
				config,
				workspace_id ?? config.defaultWorkspaceId,
				result,
			)
			const ctx = buildFormatterContext('create_session', config, workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'workspace',
				tool: 'create_session',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('create_session', config, workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `✅ **Started session** \`${result.id?.slice(0, 8) ?? '?'}\` (${result.status ?? 'pending'}) — [open in Maskin](${link})`,
					},
				],
				structuredContent: asStructuredContent(enriched),
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
			const ctx = buildFormatterContext('list_sessions', config, args.workspace_id)
			return leanReply(
				'list_sessions',
				formatGenericList(enriched as Array<SessionRow & { actorName?: string; status?: string }>, {
					label: 'session',
					row: (s) => {
						const who = s.actorName ?? s.actorId?.slice(0, 8) ?? 'agent'
						const status = (s as { status?: string }).status ?? 'pending'
						return `- \`${s.id?.slice(0, 8) ?? '?'}\` • ${who} • ${status}`
					},
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'workspace',
						tool: 'list_sessions',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				args.workspace_id,
			)
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
			)) as SessionRow & { status?: string; actorName?: string }
			const enriched = await enrichSessionActorName(config, wsId, session)

			const ctx = buildFormatterContext('get_session', config, args.workspace_id)
			const who = enriched.actorName ?? enriched.actorId?.slice(0, 8) ?? 'agent'
			const status = enriched.status ?? 'unknown'

			let logs: unknown
			if (args.include_logs) {
				const params = new URLSearchParams()
				if (args.log_limit) params.set('limit', String(args.log_limit))
				logs = await apiCall(
					config,
					'GET',
					`/api/sessions/${args.id}/logs?${params}`,
					undefined,
					wsOpts,
				)
			}

			const summary = formatGenericRecord(
				args.include_logs ? { session: enriched, logs } : enriched,
				{
					title: `Session ${args.id.slice(0, 8)}`,
					meta: `${who} • ${status}`,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'workspace',
						tool: 'get_session',
						baseUrl: ctx.baseUrl,
					},
				},
			)
			return leanReply('get_session', summary, config, args.workspace_id)
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
			})) as SessionRow & { status?: string }
			const enriched = await enrichSessionActorName(
				config,
				args.workspace_id ?? config.defaultWorkspaceId,
				result,
			)
			const ctx = buildFormatterContext('stop_session', config, args.workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'workspace',
				tool: 'stop_session',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('stop_session', config, args.workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `🛑 **Stopped session** \`${args.id.slice(0, 8)}\` (${result.status ?? 'stopped'}) — [open in Maskin](${link})`,
					},
				],
				structuredContent: asStructuredContent(enriched),
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
			})) as SessionRow & { status?: string }
			const enriched = await enrichSessionActorName(
				config,
				args.workspace_id ?? config.defaultWorkspaceId,
				result,
			)
			const ctx = buildFormatterContext('pause_session', config, args.workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'workspace',
				tool: 'pause_session',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('pause_session', config, args.workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `⏸ **Paused session** \`${args.id.slice(0, 8)}\` (${result.status ?? 'paused'}) — [open in Maskin](${link})`,
					},
				],
				structuredContent: asStructuredContent(enriched),
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
			})) as SessionRow & { status?: string }
			const enriched = await enrichSessionActorName(
				config,
				args.workspace_id ?? config.defaultWorkspaceId,
				result,
			)
			const ctx = buildFormatterContext('resume_session', config, args.workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'workspace',
				tool: 'resume_session',
				baseUrl: ctx.baseUrl,
			})
			return {
				_meta: meta('resume_session', config, args.workspace_id),
				content: [
					{
						type: 'text' as const,
						text: `▶ **Resumed session** \`${args.id.slice(0, 8)}\` (${result.status ?? 'running'}) — [open in Maskin](${link})`,
					},
				],
				structuredContent: asStructuredContent(enriched),
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

			return {
				_meta: meta('run_agent', config, args.workspace_id),
				content: [
					{ type: 'text' as const, text: JSON.stringify({ session: current, logs }, null, 2) },
				],
				structuredContent: asStructuredContent({ session: current, logs }),
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
			const result = (await apiCall(config, 'GET', '/api/integrations', undefined, {
				workspaceId: args.workspace_id,
			})) as Array<{ id: string; provider: string; name?: string | null; status?: string }>
			const ctx = buildFormatterContext('list_integrations', config, args.workspace_id)
			return leanReply(
				'list_integrations',
				formatGenericList(result, {
					label: 'integration',
					row: (i) => `- ${i.name?.trim() || i.provider}${i.status ? ` • ${i.status}` : ''}`,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'settings',
						section: 'integrations',
						tool: 'list_integrations',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				args.workspace_id,
			)
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
			})) as Array<{ id?: string; name?: string; displayName?: string }>
			// `list_integration_providers` is workspace-agnostic; if there's no
			// default workspace we can't build a deep link, so just render the list
			// without a header link.
			const wsId = config.defaultWorkspaceId
			const headerUrl = wsId
				? deepLink({
						workspaceId: wsId,
						kind: 'settings',
						section: 'integrations',
						tool: 'list_integration_providers',
						baseUrl: config.webAppBaseUrl,
					})
				: undefined
			const header = headerUrl
				? `**${result.length} provider${result.length === 1 ? '' : 's'}** — [open in Maskin](${headerUrl})`
				: `**${result.length} provider${result.length === 1 ? '' : 's'}**`
			const rows = result
				.slice(0, GENERIC_LIST_LIMIT)
				.map((p) => `- ${p.displayName ?? p.name ?? p.id ?? 'unknown'}`)
			const more =
				result.length > GENERIC_LIST_LIMIT
					? [`…and ${result.length - GENERIC_LIST_LIMIT} more`]
					: []
			const content =
				result.length === 0 ? `${header}\n\n_No providers._` : [header, ...rows, ...more].join('\n')
			return leanReply(
				'list_integration_providers',
				{ content, structuredContent: { items: result } },
				config,
				undefined,
			)
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
				_meta: meta('connect_integration', config, args.workspace_id),
				// Install URL is the action the user needs — keep it the literal first
				// thing they see. Not a deep link; this is a third-party OAuth URL.
				content: [
					{
						type: 'text' as const,
						text: `Open this URL in your browser to complete the installation:\n\n${result.install_url}`,
					},
				],
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'DELETE', `/api/integrations/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('disconnect_integration', config, args.workspace_id)
			return {
				...leanReply(
					'disconnect_integration',
					formatMutationConfirm(
						{
							verb: 'Disconnected integration',
							results: [{ type: 'integration', id: args.id, success: true }],
							section: 'integrations',
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const ctx = buildFormatterContext('set_llm_api_key', config, args.workspace_id)
			return {
				...leanReply(
					'set_llm_api_key',
					formatMutationConfirm(
						{
							verb: `Saved ${args.provider} key`,
							results: [{ type: 'llm_key', id: args.provider, success: true }],
							section: 'keys',
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const ctx = buildFormatterContext('get_llm_api_keys', config, wsId)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'settings',
				section: 'keys',
				tool: 'get_llm_api_keys',
				baseUrl: ctx.baseUrl,
			})
			const lines = [
				`#### [LLM API keys](${link})`,
				`- anthropic: ${result.anthropic.set ? `set (…${result.anthropic.last4})` : 'not set'}`,
				`- openai: ${result.openai.set ? `set (…${result.openai.last4})` : 'not set'}`,
			]
			return leanReply(
				'get_llm_api_keys',
				{ content: lines.join('\n'), structuredContent: result },
				config,
				wsId,
			)
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
			const ctx = buildFormatterContext('delete_llm_api_key', config, args.workspace_id)
			return {
				...leanReply(
					'delete_llm_api_key',
					formatMutationConfirm(
						{
							verb: `Deleted ${args.provider} key`,
							results: [{ type: 'llm_key', id: args.provider, success: true }],
							section: 'keys',
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(
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
			)) as Record<string, unknown>
			const ctx = buildFormatterContext('import_claude_subscription', config, args.workspace_id)
			return {
				...leanReply(
					'import_claude_subscription',
					formatMutationConfirm(
						{
							verb: 'Imported Claude subscription',
							results: [{ type: 'claude_oauth', success: true }],
							section: 'keys',
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const result = (await apiCall(config, 'GET', '/api/claude-oauth/status', undefined, {
				workspaceId: args.workspace_id,
			})) as { connected?: boolean; valid?: boolean }
			const ctx = buildFormatterContext('get_claude_subscription_status', config, args.workspace_id)
			const link = deepLink({
				workspaceId: ctx.workspaceId,
				kind: 'settings',
				section: 'keys',
				tool: 'get_claude_subscription_status',
				baseUrl: ctx.baseUrl,
			})
			const state = result.connected
				? result.valid
					? 'connected · valid'
					: 'connected · expired'
				: 'not connected'
			return leanReply(
				'get_claude_subscription_status',
				{
					content: `#### [Claude subscription](${link})\n_${state}_`,
					structuredContent: result,
				},
				config,
				args.workspace_id,
			)
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
			const result = (await apiCall(config, 'DELETE', '/api/claude-oauth', undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>
			const ctx = buildFormatterContext('disconnect_claude_subscription', config, args.workspace_id)
			return {
				...leanReply(
					'disconnect_claude_subscription',
					formatMutationConfirm(
						{
							verb: 'Disconnected Claude subscription',
							results: [{ type: 'claude_oauth', success: true }],
							section: 'keys',
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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
			const ctx = buildFormatterContext('list_extensions', config, args.workspace_id)
			return leanReply(
				'list_extensions',
				formatGenericList(result, {
					label: 'extension',
					row: (ext) =>
						`- **${ext.name || ext.id}** — ${ext.enabled ? 'enabled' : 'disabled'} • ${ext.object_types.length} type${ext.object_types.length === 1 ? '' : 's'}`,
					linkInput: {
						workspaceId: ctx.workspaceId,
						kind: 'workspace',
						tool: 'list_extensions',
						baseUrl: ctx.baseUrl,
					},
				}),
				config,
				args.workspace_id,
			)
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
						_meta: meta('create_extension', config, args.workspace_id),
						content: [
							{
								type: 'text' as const,
								text: `Extension "${args.id}" is already enabled.`,
							},
						],
						structuredContent: { skipped: true, reason: 'already_enabled', id: args.id },
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

				const ctx = buildFormatterContext('create_extension', config, args.workspace_id)
				return {
					...leanReply(
						'create_extension',
						formatMutationConfirm(
							{
								verb: `Enabled extension "${args.id}"`,
								results: [{ type: 'extension', id: args.id, success: true }],
							},
							ctx,
						),
						config,
						args.workspace_id,
					),
					structuredContent: asStructuredContent(result),
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

			const ctx = buildFormatterContext('create_extension', config, args.workspace_id)
			return {
				...leanReply(
					'create_extension',
					formatMutationConfirm(
						{
							verb: `Created custom extension "${args.id}"`,
							results: [{ type: 'extension', id: args.id, success: true }],
						},
						ctx,
					),
					config,
					args.workspace_id,
				),
				structuredContent: asStructuredContent(result),
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

					const ctx = buildFormatterContext('update_extension', config, args.workspace_id)
					return {
						...leanReply(
							'update_extension',
							formatMutationConfirm(
								{
									verb: `${args.enabled ? 'Enabled' : 'Disabled'} extension "${args.id}"`,
									results: [{ type: 'extension', id: args.id, success: true }],
								},
								ctx,
							),
							config,
							args.workspace_id,
						),
						structuredContent: asStructuredContent(result),
					}
				}

				if (args.enabled) {
					// Enable — check if it's a registered module
					const allModules = getAllModules()
					const mod = allModules.find((m) => m.id === args.id)
					if (mod) {
						if (enabledModules.includes(args.id)) {
							return {
								_meta: meta('update_extension', config, args.workspace_id),
								content: [
									{
										type: 'text' as const,
										text: `Extension "${args.id}" is already enabled.`,
									},
								],
								structuredContent: { skipped: true, reason: 'already_enabled', id: args.id },
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

						const ctx = buildFormatterContext('update_extension', config, args.workspace_id)
						return {
							...leanReply(
								'update_extension',
								formatMutationConfirm(
									{
										verb: `Enabled extension "${args.id}"`,
										results: [{ type: 'extension', id: args.id, success: true }],
									},
									ctx,
								),
								config,
								args.workspace_id,
							),
							structuredContent: asStructuredContent(result),
						}
					}

					// Not a registered module or custom extension
					throw new Error(
						`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
					)
				}

				if (!enabledModules.includes(args.id)) {
					return {
						_meta: meta('update_extension', config, args.workspace_id),
						content: [
							{
								type: 'text' as const,
								text: `Extension "${args.id}" is not currently enabled.`,
							},
						],
						structuredContent: { skipped: true, reason: 'not_enabled', id: args.id },
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

				const ctx = buildFormatterContext('update_extension', config, args.workspace_id)
				return {
					...leanReply(
						'update_extension',
						formatMutationConfirm(
							{
								verb: `Disabled extension "${args.id}"`,
								results: [{ type: 'extension', id: args.id, success: true }],
							},
							ctx,
						),
						config,
						args.workspace_id,
					),
					structuredContent: asStructuredContent(result),
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

				const ctx = buildFormatterContext('update_extension', config, args.workspace_id)
				return {
					...leanReply(
						'update_extension',
						formatMutationConfirm(
							{
								verb: `Updated extension "${args.id}"`,
								results: [{ type: 'extension', id: args.id, success: true }],
							},
							ctx,
						),
						config,
						args.workspace_id,
					),
					structuredContent: asStructuredContent(result),
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

				const ctx = buildFormatterContext('delete_extension', config, args.workspace_id)
				return {
					...leanReply(
						'delete_extension',
						formatMutationConfirm(
							{
								verb: `Deleted extension "${args.id}"`,
								results: [{ type: 'extension', id: args.id, success: true }],
							},
							ctx,
						),
						config,
						args.workspace_id,
					),
					structuredContent: asStructuredContent({ removed, workspace: result }),
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

				const ctx = buildFormatterContext('delete_extension', config, args.workspace_id)
				return {
					...leanReply(
						'delete_extension',
						formatMutationConfirm(
							{
								verb: `Deleted type "${args.id}"`,
								results: [{ type: 'extension', id: args.id, success: true }],
							},
							ctx,
						),
						config,
						args.workspace_id,
					),
					structuredContent: asStructuredContent(result),
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

			// Resolve workspace
			let workspace: { id: string; name: string; settings: Record<string, unknown> } | undefined
			try {
				const workspaces = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
					skipWorkspace: true,
				})) as Array<{ id: string; name: string; settings: Record<string, unknown> }>
				const effectiveWsId = args.workspace_id ?? config.defaultWorkspaceId
				workspace =
					(effectiveWsId ? workspaces.find((w) => w.id === effectiveWsId) : workspaces[0]) ??
					workspaces[0]
			} catch {
				const setupSteps =
					config.transport === 'http'
						? "  1. Sign in at https://maskin.sindre.ai and create a workspace\n  2. Copy your Maskin API key from Settings → API keys and your Workspace ID from Settings → Workspace\n  3. Reconnect Claude with `claude mcp add maskin --transport http --url https://maskin.sindre.ai/mcp --header 'Authorization: Bearer <YOUR_MASKIN_API_KEY>' --header 'X-Workspace-Id: <YOUR_WORKSPACE_ID>'`\n  4. Run /reload-plugins, then call get_started again\n\nFull guide: https://sindre.ai/docs/get-started/"
						: '  1. Call create_actor to get an API key\n  2. Restart with API_KEY set\n  3. Call get_started again'
				return textResponse(
					`👋 Welcome to Maskin!\n\nI can't reach your workspace yet. To finish setup:\n${setupSteps}\n\nOr pass a workspace_id directly if you have one.`,
				)
			}

			if (!workspace) {
				return textResponse(
					'👋 Welcome to Maskin!\n\nNo workspace found on this account. Call create_workspace first with a name, then run get_started again to apply a template.',
				)
			}

			// Pick template
			const pickTemplate = (): WorkspaceTemplateId | 'custom' | null => {
				if (args.template) return args.template
				const hint = (args.use_case ?? '').toLowerCase()
				if (!hint) return null
				if (/growth|launch|market|sales|outreach|pipeline|crm|lead/.test(hint)) return 'growth'
				if (/dev|engineering|product|build|ship|feature|spec|sprint|backlog/.test(hint))
					return 'development'
				return null
			}

			const chosen = pickTemplate()

			if (chosen === null) {
				return textResponse(
					`👋 Welcome to Maskin, let's set up "${workspace.name}".\n\nPick a starting template by calling get_started again with one of:\n\n  • template: "development" — for product teams shipping software (bets, tasks, insights with dev statuses)\n  • template: "growth" — for founders running a pipeline (adds contact + company with a light CRM)\n  • template: "custom" — I'll ask a few questions and tailor the workspace\n\nOr just tell me the use_case in your own words and I'll pick for you.`,
				)
			}

			if (chosen === 'custom') {
				if (!args.custom_settings) {
					return textResponse(
						`🧵 Custom workspace setup for "${workspace.name}"\n\nTell me a bit about how you work and I'll tailor the settings:\n\n  1. What kinds of things do you want to track? (e.g. bets, tasks, insights, contacts, campaigns, experiments…)\n  2. For each one, what are the statuses it moves through?\n  3. Are there any custom fields that matter? (e.g. deadline, priority, impact/effort, source)\n  4. Any common relationship types? (default: informs, breaks_into, blocks, relates_to)\n\nWhen you have answers, call get_started again with:\n  template: "custom"\n  custom_settings: { display_names, statuses, field_definitions, relationship_types, custom_extensions }\n  confirm: true\n\nReference shape: call get_workspace_schema to see the current settings object.`,
					)
				}
				// custom settings provided — apply on confirm
				if (!args.confirm) {
					return textResponse(
						`📋 Preview — custom settings for "${workspace.name}"\n\n${JSON.stringify(args.custom_settings, null, 2)}\n\nCall get_started again with the same args plus confirm: true to apply.`,
					)
				}
				try {
					await apiCall(
						config,
						'PATCH',
						`/api/workspaces/${workspace.id}`,
						{ settings: args.custom_settings },
						{ workspaceId: workspace.id },
					)
					return textResponse(
						`✅ Custom settings applied to "${workspace.name}".\n\nNext steps:\n  1. Call get_workspace_schema to verify\n  2. Use create_objects to add your first items\n  3. Call list_objects to see what's in the workspace`,
					)
				} catch (err) {
					return textResponse(`❌ Failed to apply custom settings: ${String(err)}`)
				}
			}

			// dev or growth template
			const template: WorkspaceTemplate = WORKSPACE_TEMPLATES[chosen]
			const mergedSettings = mergeEnabledModuleDefaults(
				template.settings as Record<string, unknown>,
			)

			if (!args.confirm) {
				const previewLines: string[] = []
				const statuses = (mergedSettings.statuses ?? {}) as Record<string, string[]>
				const fields = (mergedSettings.field_definitions ?? {}) as Record<
					string,
					Array<{ name: string; type: string; values?: string[] }>
				>
				const displayNames = (mergedSettings.display_names ?? {}) as Record<string, string>
				for (const [type, typeStatuses] of Object.entries(statuses)) {
					const name = displayNames[type] ?? type
					const line = `  • ${name} (${type}): ${typeStatuses.join(' → ')}`
					const typeFields = fields[type]
					if (typeFields && typeFields.length > 0) {
						const fieldDesc = typeFields
							.map((f) =>
								f.values && f.values.length > 0
									? `${f.name} [${f.values.join('|')}]`
									: `${f.name} (${f.type})`,
							)
							.join(', ')
						previewLines.push(`${line}\n      Fields: ${fieldDesc}`)
					} else {
						previewLines.push(line)
					}
				}
				const extLines = Object.entries(template.settings.custom_extensions ?? {}).map(
					([id, ext]) => `  • ${ext.name} (${id}): types [${ext.types.join(', ')}]`,
				)
				const seedLines = template.seedNodes.map(
					(n) => `  • [${n.$id}] ${displayNames[n.type] ?? n.type}: ${n.title}`,
				)

				return textResponse(
					`📋 Preview — "${template.name}" template for workspace "${workspace.name}"

${template.description}

Object types & statuses:
${previewLines.join('\n')}
${extLines.length > 0 ? `\nCustom extensions:\n${extLines.join('\n')}\n` : ''}
Seed examples (${template.seedNodes.length} objects + ${template.seedEdges.length} relationships):
${seedLines.join('\n')}

Before applying, ASK THE USER these questions in one message so we can tailor the workspace. They can answer any, all, or none:
  1. What should I name the workspace? (currently "${workspace.name}")
  2. What are you building or working on?
  3. Any near-term goal or milestone I should reflect in the starter examples?

Then call get_started again with confirm: true, and (if the user told you anything) pass workspace_name and/or seed_overrides keyed by the [$id] shown above. If the user said "just apply it" or gave nothing, call with only { template: "${template.id}", confirm: true }.`,
				)
			}

			// Apply: optional rename → merge settings → seed objects via /api/graph
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

			try {
				await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${workspace.id}`,
					{ settings: mergedSettings },
					{ workspaceId: workspace.id },
				)
			} catch (err) {
				return textResponse(
					`❌ Failed to apply template settings: ${String(err)}\n\nNothing was seeded. You can retry or run create_workspace-specific tools manually.`,
				)
			}

			const overrides = args.seed_overrides ?? {}
			const tailoredNodes = template.seedNodes.map((n) => {
				const o = overrides[n.$id]
				if (!o) return n
				return {
					...n,
					title: o.title ?? n.title,
					content: o.content ?? n.content,
					metadata: o.metadata ? { ...n.metadata, ...o.metadata } : n.metadata,
				}
			})

			let seedSummary = ''
			try {
				const graphResult = (await apiCall(
					config,
					'POST',
					'/api/graph',
					{ nodes: tailoredNodes, edges: template.seedEdges },
					{ workspaceId: workspace.id },
				)) as { objects?: Array<{ id: string }>; relationships?: Array<{ id: string }> }
				const createdObjects = graphResult.objects?.length ?? tailoredNodes.length
				const createdEdges = graphResult.relationships?.length ?? template.seedEdges.length
				seedSummary = `Seeded ${createdObjects} example objects and ${createdEdges} relationships.`
			} catch (err) {
				seedSummary = `Settings applied, but seeding examples failed: ${String(err)}. You can re-run get_started or add objects manually.`
			}

			// Create seed agents (if any). Track $id → real UUID so triggers can resolve
			// their target actor, and so {{self_id}} placeholders in system prompts can
			// be substituted with the real actor id in a second PATCH.
			const actorIdMap: Record<string, string> = {}
			let agentsCreated = 0
			if (template.seedAgents && template.seedAgents.length > 0) {
				for (const agent of template.seedAgents) {
					try {
						const created = (await apiCall(
							config,
							'POST',
							'/api/actors',
							{
								type: 'agent',
								name: agent.name,
								system_prompt: agent.systemPrompt,
								tools: agent.tools,
							},
							{ workspaceId: workspace.id },
						)) as { id: string }
						actorIdMap[agent.$id] = created.id
						// Add the agent to the workspace so it shows up in the UI's
						// agents page (which inner-joins workspace_members) and can be
						// invoked as a workspace member by triggers and humans.
						// Non-fatal: if this fails, the agent still exists and triggers
						// (which FK to actors only) can still fire it.
						try {
							await apiCall(
								config,
								'POST',
								`/api/workspaces/${workspace.id}/members`,
								{ actor_id: created.id, role: 'member' },
								{ workspaceId: workspace.id },
							)
						} catch (err) {
							seedSummary += ` Failed to add agent "${agent.name}" to workspace members: ${String(err)}.`
						}
						// Second pass: substitute {{self_id}} in the system prompt.
						if (agent.systemPrompt.includes('{{self_id}}')) {
							const substituted = agent.systemPrompt.replaceAll('{{self_id}}', created.id)
							await apiCall(
								config,
								'PATCH',
								`/api/actors/${created.id}`,
								{ system_prompt: substituted },
								{ workspaceId: workspace.id },
							)
						}
						agentsCreated++
					} catch (err) {
						seedSummary += ` Failed to create agent "${agent.name}": ${String(err)}.`
					}
				}
			}

			// Create seed triggers, resolving targetActor$id to a real UUID.
			let triggersCreated = 0
			if (template.seedTriggers && template.seedTriggers.length > 0) {
				for (const trigger of template.seedTriggers) {
					const targetActorId = actorIdMap[trigger.targetActor$id] ?? trigger.targetActor$id
					try {
						const substitutedPrompt = trigger.actionPrompt.replaceAll('{{self_id}}', targetActorId)
						await apiCall(
							config,
							'POST',
							'/api/triggers',
							{
								name: trigger.name,
								type: trigger.type,
								config: trigger.config,
								action_prompt: substitutedPrompt,
								target_actor_id: targetActorId,
								enabled: trigger.enabled,
							},
							{ workspaceId: workspace.id },
						)
						triggersCreated++
					} catch (err) {
						seedSummary += ` Failed to create trigger "${trigger.name}": ${String(err)}.`
					}
				}
			}

			if (agentsCreated > 0 || triggersCreated > 0) {
				seedSummary += ` Created ${agentsCreated} agents and ${triggersCreated} triggers that drive the pipeline.`
			}

			const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')
			// Magic-link auto-auth is only safe on localhost: the URL carries the raw
			// API key in its fragment, so it must not end up in shared browser history,
			// agent transcripts, or forwarded links. For any non-local frontend, emit a
			// plain URL and let the user sign in normally.
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
					)) as Array<{
						actorId: string
						name: string | null
						email: string | null
						type: string
					}>
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

			// Check whether the user has already imported Claude subscription credentials.
			// Agent sessions can't run without them, so onboarding should ask the user to
			// add them before the pipeline kicks off. Best-effort — ignore failures.
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

INSTRUCTIONS FOR THE "Connect your Claude subscription" SECTION — render this BEFORE "How to get the machine moving". The agents in this workspace run Claude sessions, which need the user's Claude subscription credentials (you can't import them via MCP — the user has to paste them). Render EXACTLY this format:

  🔑 Connect your Claude subscription
     Open ${keysUrl} → "Import credentials" and paste the output of the terminal command shown there. Agents can't run until this is done.

Then on a NEW line, ask: "Let me know once that's done and I'll kick things off." Do NOT proceed to the "How to get the machine moving" steps until the user confirms credentials are imported (or explicitly says to skip). If they skip, flag that agent sessions will fail until credentials are added.`

			const devPipelineGuidance =
				chosen === 'development'
					? `

The development pipeline is wired up end-to-end: Bet Planner → Senior Developer → Code Reviewer → CTO → Development Driver. The user steers; the agents build.

INSTRUCTIONS FOR THE "How to get the machine moving" SECTION — do NOT print this block verbatim. Render EXACTLY this format (no extra prose, no per-step explanations):

  How to get the machine moving — just say yes and I'll:
    1. Connect GitHub
    2. Sharpen the starter tasks
    3. Kick off task 1 (Senior Developer picks it up)
    4. Hand off to Code Reviewer + CTO for review and merge

  Should I start now?

Then STOP. Do not explain each step — one line each, nothing more. Wait for the user to say yes/go/start before taking any action.

When the user confirms (yes / go / start / do it / sure), execute the steps in order: (a) call connect_integration for provider "github" — ask only for the repo URL if needed; (b) set the seed bet's \`github_link\` metadata to that repo URL; (c) use update_objects to rewrite task1 + task2 into concrete tickets with specific files/areas, acceptance criteria, and dependencies, tailored to what the user told you earlier; (d) move task1 to "in_progress"; (e) briefly confirm each step as you go ("✅ GitHub connected", "✅ Repo attached to bet", etc.). After step (d), tell the user the pipeline is running and they'll be pinged when the PR needs review — then on a NEW line, offer to use the wait time productively with something like: "Want to set up anything else while the agents work? A couple of options: connect Slack so you can drop feedback/insights into the workspace and chat with agents from where you already are, or wire up another integration. Or we can just wait." Keep this offer short (one short paragraph, not a bulleted list).

If the user says "not now" or steers elsewhere, follow their direction.`
					: `

INSTRUCTIONS FOR THE "How to get the machine moving" SECTION — do NOT print verbatim. Render a terse list of 2–3 one-line items (a few words each) tailored to what the user told you earlier. End with "Should I start now?" on its own line. Do not explain each item. Wait for the user to confirm before acting.`

			return textResponse(
				`✅ "${template.name}" template applied to workspace "${workspace.name}". ${seedSummary}

🌐 Open the workspace in your browser: ${workspaceUrl}

Template pitch (use to describe what the user just got — rephrase in your own voice, don't quote verbatim):
${template.pitch}

INSTRUCTIONS FOR THE AGENT — do NOT print this block verbatim. Write a short, excited message with these parts in order:
  1. An enthusiastic opener grounded in the template pitch above. Frame it as "you now have your own [AI team / execution machine / growth engine]" — make it feel like a capability unlock, not a config change. 2–3 sentences.
  2. The workspace URL above as a clickable link.
  3. ${claudeOauthConnected ? 'A "How to get the machine moving" section — see the template-specific guidance below.' : 'A "Connect your Claude subscription" section (see guidance below) BEFORE the "How to get the machine moving" section.'}${claudeCredsBlock}${devPipelineGuidance}`,
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
		webAppBaseUrl: process.env.WEB_APP_URL || process.env.FRONTEND_URL,
	}

	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('MCP server started (stdio transport)')
}

main().catch(console.error)
