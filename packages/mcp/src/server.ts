import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAllModules, getModuleDefaultSettings } from '@maskin/module-sdk'
import type { CustomExtensionEntry } from '@maskin/shared'
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import {
	formatActor,
	formatActorList,
	formatConfirmation,
	formatDashboard,
	formatEventList,
	formatExtensionList,
	formatIntegrationList,
	formatNotification,
	formatNotificationList,
	formatObjectGraph,
	formatObjectList,
	formatProviderList,
	formatRelationshipList,
	formatSchema,
	formatSession,
	formatSessionList,
	formatTrigger,
	formatTriggerList,
	formatWorkspace,
	formatWorkspaceList,
} from './formatters.js'
import { tools } from './tools.js'

interface McpConfig {
	apiBaseUrl: string
	apiKey: string
	defaultWorkspaceId: string
	/** Path to the directory containing built MCP app HTML files */
	htmlBasePath?: string
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
} as const

const CSP = {
	'font-src': ['https://fonts.gstatic.com'],
	'style-src': ['https://fonts.googleapis.com'],
} as const

// ─── Tool result helper ──────────────────────────────────
// Returns structuredContent (for MCP apps) + formatted text + JSON fallback (for AI assistants & old clients)
function toolResult(toolName: string, data: unknown, formatted: string) {
	return {
		_meta: { toolName },
		structuredContent: data as Record<string, unknown>,
		content: [
			{ type: 'text' as const, text: formatted },
			{ type: 'text' as const, text: JSON.stringify(data, null, 2) },
		],
	}
}

// ─── Tool annotation presets ─────────────────────────────
const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
}
const MUTATE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
}
const MUTATE_IDEMPOTENT: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
}
const DESTRUCTIVE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
}
const SIDE_EFFECT: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
}

async function apiCall(
	config: McpConfig,
	method: string,
	path: string,
	body?: unknown,
	options?: { skipAuth?: boolean; skipWorkspace?: boolean; workspaceId?: string },
): Promise<unknown> {
	if (!options?.skipAuth && !config.apiKey) {
		throw new Error(
			'Not authenticated. Use the create_actor tool first to sign up and get an API key, then restart the MCP server with API_KEY set.',
		)
	}
	const effectiveWorkspaceId = options?.workspaceId ?? config.defaultWorkspaceId
	if (!options?.skipAuth && !options?.skipWorkspace && !effectiveWorkspaceId) {
		throw new Error(
			'No workspace specified. Either pass workspace_id to this tool, set DEFAULT_WORKSPACE_ID environment variable, or call list_workspaces to find your workspace ID.',
		)
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

	// ─── Register UI resources ─────────────────────────────────
	for (const [name, uri] of Object.entries(UI_RESOURCES)) {
		registerAppResource(server, `${name}-ui`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
			console.log(`[MCP] Resource read requested: ${uri} (${name}.html)`)
			return {
				contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: loadHtml(config, `${name}.html`) }],
			}
		})
	}

	// ─── Objects ───────────────────────────────────────────────
	registerAppTool(
		server,
		'create_objects',
		{
			description: tools.create_objects.description,
			inputSchema: tools.create_objects.inputSchema.shape,
			annotations: MUTATE,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = (await apiCall(config, 'POST', '/api/graph', body, {
				workspaceId: workspace_id,
			})) as { nodes?: unknown[]; edges?: unknown[] }
			const nodeCount = result.nodes?.length ?? 0
			const edgeCount = result.edges?.length ?? 0
			const detail = [
				nodeCount && `${nodeCount} object${nodeCount > 1 ? 's' : ''}`,
				edgeCount && `${edgeCount} relationship${edgeCount > 1 ? 's' : ''}`,
			]
				.filter(Boolean)
				.join(', ')
			return toolResult(
				'create_objects',
				result,
				formatConfirmation('Created', detail || 'objects'),
			)
		},
	)

	registerAppTool(
		server,
		'get_objects',
		{
			description: tools.get_objects.description,
			inputSchema: tools.get_objects.inputSchema.shape,
			annotations: READ_ONLY,
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
						return { id, success: true, result }
					} catch (error) {
						return { id, success: false, error: String(error) }
					}
				}),
			)
			const formatted = results
				.map((r) =>
					r.success
						? formatObjectGraph(r.result as Record<string, unknown>)
						: `❌ ${r.id}: ${r.error}`,
				)
				.join('\n\n')
			return toolResult('get_objects', { data: results }, formatted)
		},
	)

	registerAppTool(
		server,
		'update_objects',
		{
			description: tools.update_objects.description,
			inputSchema: tools.update_objects.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const { workspace_id } = args
			const wsOpts = { workspaceId: workspace_id }
			const results: Array<{
				type: string
				id?: string
				success: boolean
				result?: unknown
				error?: string
			}> = []

			// Update objects in parallel
			if (args.updates?.length) {
				const objectResults = await Promise.all(
					args.updates.map(async ({ id, ...body }) => {
						try {
							const result = await apiCall(config, 'PATCH', `/api/objects/${id}`, body, wsOpts)
							return { type: 'object' as const, id, success: true, result }
						} catch (error) {
							return { type: 'object' as const, id, success: false, error: String(error) }
						}
					}),
				)
				results.push(...objectResults)
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

			const succeeded = results.filter((r) => r.success).length
			const failed = results.length - succeeded
			const detail = [`${succeeded} succeeded`, failed && `${failed} failed`]
				.filter(Boolean)
				.join(', ')
			return toolResult('update_objects', { data: results }, formatConfirmation('Updated', detail))
		},
	)

	registerAppTool(
		server,
		'delete_object',
		{
			description: tools.delete_object.description,
			inputSchema: tools.delete_object.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/objects/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult('delete_object', result, formatConfirmation('Deleted object', args.id))
		},
	)

	registerAppTool(
		server,
		'list_objects',
		{
			description: tools.list_objects.description,
			inputSchema: tools.list_objects.inputSchema.shape,
			annotations: READ_ONLY,
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
			})) as Record<string, unknown>[]
			return toolResult(
				'list_objects',
				{ data: result },
				formatObjectList(result, { offset: args.offset }),
			)
		},
	)

	registerAppTool(
		server,
		'search_objects',
		{
			description: tools.search_objects.description,
			inputSchema: tools.search_objects.inputSchema.shape,
			annotations: READ_ONLY,
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
			})) as Record<string, unknown>[]
			return toolResult(
				'search_objects',
				{ data: result },
				formatObjectList(result, { query: args.q, offset: args.offset }),
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
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.source_id) params.set('source_id', args.source_id)
			if (args.target_id) params.set('target_id', args.target_id)
			if (args.type) params.set('type', args.type)
			const result = (await apiCall(config, 'GET', `/api/relationships?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>[]
			return toolResult('list_relationships', { data: result }, formatRelationshipList(result))
		},
	)

	registerAppTool(
		server,
		'delete_relationship',
		{
			description: tools.delete_relationship.description,
			inputSchema: tools.delete_relationship.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: { ui: { resourceUri: UI_RESOURCES.relationships, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/relationships/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult(
				'delete_relationship',
				result,
				formatConfirmation('Deleted relationship', args.id),
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
			annotations: MUTATE,
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

			return toolResult('create_actor', result, formatActor(result as Record<string, unknown>))
		},
	)

	registerAppTool(
		server,
		'list_actors',
		{
			description: tools.list_actors.description,
			inputSchema: tools.list_actors.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async () => {
			const result = (await apiCall(config, 'GET', '/api/actors', undefined, {
				skipWorkspace: true,
			})) as Record<string, unknown>[]
			return toolResult('list_actors', { data: result }, formatActorList(result))
		},
	)

	registerAppTool(
		server,
		'get_actor',
		{
			description: tools.get_actor.description,
			inputSchema: tools.get_actor.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', `/api/actors/${args.id}`, undefined, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			return toolResult('get_actor', result, formatActor(result))
		},
	)

	registerAppTool(
		server,
		'update_actor',
		{
			description: tools.update_actor.description,
			inputSchema: tools.update_actor.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const { id, ...body } = args
			const result = (await apiCall(config, 'PATCH', `/api/actors/${id}`, body, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			return toolResult('update_actor', result, formatActor(result))
		},
	)

	registerAppTool(
		server,
		'regenerate_api_key',
		{
			description: tools.regenerate_api_key.description,
			inputSchema: tools.regenerate_api_key.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: { ui: { resourceUri: UI_RESOURCES.actors, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/actors/${args.id}/api-keys`, undefined, {
				skipWorkspace: true,
			})
			return toolResult(
				'regenerate_api_key',
				result,
				formatConfirmation('Regenerated API key', `actor ${args.id}`),
			)
		},
	)

	// ─── Workspaces ───────────────────────────────────────────
	registerAppTool(
		server,
		'create_workspace',
		{
			description: tools.create_workspace.description,
			inputSchema: tools.create_workspace.inputSchema.shape,
			annotations: MUTATE,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'POST', '/api/workspaces', args, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			return toolResult('create_workspace', result, formatWorkspace(result))
		},
	)

	registerAppTool(
		server,
		'update_workspace',
		{
			description: tools.update_workspace.description,
			inputSchema: tools.update_workspace.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const { id, ...body } = args
			const result = (await apiCall(config, 'PATCH', `/api/workspaces/${id}`, body, {
				skipWorkspace: true,
			})) as Record<string, unknown>
			return toolResult('update_workspace', result, formatWorkspace(result))
		},
	)

	registerAppTool(
		server,
		'list_workspaces',
		{
			description: tools.list_workspaces.description,
			inputSchema: tools.list_workspaces.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async () => {
			const result = (await apiCall(config, 'GET', '/api/workspaces', undefined, {
				skipWorkspace: true,
			})) as Record<string, unknown>[]
			return toolResult('list_workspaces', { data: result }, formatWorkspaceList(result))
		},
	)

	registerAppTool(
		server,
		'get_workspace_schema',
		{
			description: tools.get_workspace_schema.description,
			inputSchema: tools.get_workspace_schema.inputSchema.shape,
			annotations: READ_ONLY,
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

			return toolResult(
				'get_workspace_schema',
				schema,
				formatSchema(schema as Record<string, unknown>),
			)
		},
	)

	registerAppTool(
		server,
		'add_workspace_member',
		{
			description: tools.add_workspace_member.description,
			inputSchema: tools.add_workspace_member.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
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
			return toolResult(
				'add_workspace_member',
				result,
				formatConfirmation('Added member', `actor ${args.actor_id} as ${args.role ?? 'member'}`),
			)
		},
	)

	// ─── Events ───────────────────────────────────────────────
	registerAppTool(
		server,
		'get_events',
		{
			description: tools.get_events.description,
			inputSchema: tools.get_events.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.entity_type) params.set('entity_type', args.entity_type)
			if (args.action) params.set('action', args.action)
			if (args.limit) params.set('limit', String(args.limit))
			const result = (await apiCall(config, 'GET', `/api/events/history?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>[]
			return toolResult('get_events', { data: result }, formatEventList(result))
		},
	)

	// ─── Triggers ─────────────────────────────────────────────
	registerAppTool(
		server,
		'create_trigger',
		{
			description: tools.create_trigger.description,
			inputSchema: tools.create_trigger.inputSchema.shape,
			annotations: MUTATE,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = (await apiCall(config, 'POST', '/api/triggers', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			return toolResult('create_trigger', result, formatTrigger(result))
		},
	)

	registerAppTool(
		server,
		'list_triggers',
		{
			description: tools.list_triggers.description,
			inputSchema: tools.list_triggers.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', '/api/triggers', undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>[]
			return toolResult('list_triggers', { data: result }, formatTriggerList(result))
		},
	)

	registerAppTool(
		server,
		'update_trigger',
		{
			description: tools.update_trigger.description,
			inputSchema: tools.update_trigger.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const { id, workspace_id, ...body } = args
			const result = (await apiCall(config, 'PATCH', `/api/triggers/${id}`, body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			return toolResult('update_trigger', result, formatTrigger(result))
		},
	)

	registerAppTool(
		server,
		'delete_trigger',
		{
			description: tools.delete_trigger.description,
			inputSchema: tools.delete_trigger.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: { ui: { resourceUri: UI_RESOURCES.triggers, csp: CSP } },
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/triggers/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult('delete_trigger', result, formatConfirmation('Deleted trigger', args.id))
		},
	)

	// ─── Notifications ────────────────────────────────────────
	registerAppTool(
		server,
		'create_notification',
		{
			description: tools.create_notification.description,
			inputSchema: tools.create_notification.inputSchema.shape,
			annotations: MUTATE,
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

			const result = (await apiCall(config, 'POST', '/api/notifications', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			return toolResult('create_notification', result, formatNotification(result))
		},
	)

	registerAppTool(
		server,
		'list_notifications',
		{
			description: tools.list_notifications.description,
			inputSchema: tools.list_notifications.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.status) params.set('status', args.status)
			if (args.type) params.set('type', args.type)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = (await apiCall(config, 'GET', `/api/notifications?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>[]
			return toolResult('list_notifications', { data: result }, formatNotificationList(result))
		},
	)

	registerAppTool(
		server,
		'get_notification',
		{
			description: tools.get_notification.description,
			inputSchema: tools.get_notification.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', `/api/notifications/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>
			return toolResult('get_notification', result, formatNotification(result))
		},
	)

	registerAppTool(
		server,
		'update_notification',
		{
			description: tools.update_notification.description,
			inputSchema: tools.update_notification.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: {},
		},
		async (args) => {
			const { id, workspace_id, ...body } = args
			const result = (await apiCall(config, 'PATCH', `/api/notifications/${id}`, body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			return toolResult('update_notification', result, formatNotification(result))
		},
	)

	registerAppTool(
		server,
		'delete_notification',
		{
			description: tools.delete_notification.description,
			inputSchema: tools.delete_notification.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/notifications/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult(
				'delete_notification',
				result,
				formatConfirmation('Deleted notification', args.id),
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
			annotations: SIDE_EFFECT,
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = (await apiCall(config, 'POST', '/api/sessions', body, {
				workspaceId: workspace_id,
			})) as Record<string, unknown>
			return toolResult('create_session', result, formatSession(result))
		},
	)

	registerAppTool(
		server,
		'list_sessions',
		{
			description: tools.list_sessions.description,
			inputSchema: tools.list_sessions.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.status) params.set('status', args.status)
			if (args.actor_id) params.set('actor_id', args.actor_id)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = (await apiCall(config, 'GET', `/api/sessions?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>[]
			return toolResult('list_sessions', { data: result }, formatSessionList(result))
		},
	)

	registerAppTool(
		server,
		'get_session',
		{
			description: tools.get_session.description,
			inputSchema: tools.get_session.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async (args) => {
			const wsOpts = { workspaceId: args.workspace_id }
			const session = (await apiCall(
				config,
				'GET',
				`/api/sessions/${args.id}`,
				undefined,
				wsOpts,
			)) as Record<string, unknown>

			if (args.include_logs) {
				const params = new URLSearchParams()
				if (args.log_limit) params.set('limit', String(args.log_limit))
				const logs = (await apiCall(
					config,
					'GET',
					`/api/sessions/${args.id}/logs?${params}`,
					undefined,
					wsOpts,
				)) as Record<string, unknown>[]
				const data = { session, logs }
				return toolResult('get_session', data, formatSession(session, logs))
			}

			return toolResult('get_session', session, formatSession(session))
		},
	)

	registerAppTool(
		server,
		'stop_session',
		{
			description: tools.stop_session.description,
			inputSchema: tools.stop_session.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/sessions/${args.id}/stop`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult('stop_session', result, formatConfirmation('Stopped session', args.id))
		},
	)

	registerAppTool(
		server,
		'pause_session',
		{
			description: tools.pause_session.description,
			inputSchema: tools.pause_session.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/sessions/${args.id}/pause`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult('pause_session', result, formatConfirmation('Paused session', args.id))
		},
	)

	registerAppTool(
		server,
		'resume_session',
		{
			description: tools.resume_session.description,
			inputSchema: tools.resume_session.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/sessions/${args.id}/resume`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult('resume_session', result, formatConfirmation('Resumed session', args.id))
		},
	)

	registerAppTool(
		server,
		'run_agent',
		{
			description: tools.run_agent.description,
			inputSchema: tools.run_agent.inputSchema.shape,
			annotations: SIDE_EFFECT,
			_meta: {},
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
			const logs = (await apiCall(
				config,
				'GET',
				`/api/sessions/${sessionId}/logs?limit=500`,
				undefined,
				wsOpts,
			)) as Record<string, unknown>[]

			const data = { session: current, logs }
			return toolResult('run_agent', data, formatSession(current as Record<string, unknown>, logs))
		},
	)

	// ─── Integrations ─────────────────────────────────────────
	registerAppTool(
		server,
		'list_integrations',
		{
			description: tools.list_integrations.description,
			inputSchema: tools.list_integrations.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async (args) => {
			const result = (await apiCall(config, 'GET', '/api/integrations', undefined, {
				workspaceId: args.workspace_id,
			})) as Record<string, unknown>[]
			return toolResult('list_integrations', { data: result }, formatIntegrationList(result))
		},
	)

	registerAppTool(
		server,
		'list_integration_providers',
		{
			description: tools.list_integration_providers.description,
			inputSchema: tools.list_integration_providers.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async () => {
			const result = (await apiCall(config, 'GET', '/api/integrations/providers', undefined, {
				skipWorkspace: true,
			})) as Record<string, unknown>[]
			return toolResult('list_integration_providers', { data: result }, formatProviderList(result))
		},
	)

	registerAppTool(
		server,
		'connect_integration',
		{
			description: tools.connect_integration.description,
			inputSchema: tools.connect_integration.inputSchema.shape,
			annotations: SIDE_EFFECT,
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
			const formatted = `🔗 Connect ${args.provider}\n\nOpen this URL in your browser to complete the installation:\n${result.install_url}`
			return toolResult('connect_integration', result, formatted)
		},
	)

	registerAppTool(
		server,
		'disconnect_integration',
		{
			description: tools.disconnect_integration.description,
			inputSchema: tools.disconnect_integration.inputSchema.shape,
			annotations: DESTRUCTIVE,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'DELETE', `/api/integrations/${args.id}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return toolResult(
				'disconnect_integration',
				result,
				formatConfirmation('Disconnected integration', args.id),
			)
		},
	)

	// ─── Extensions ──────────────────────────────────────────
	registerAppTool(
		server,
		'list_extensions',
		{
			description: tools.list_extensions.description,
			inputSchema: tools.list_extensions.inputSchema.shape,
			annotations: READ_ONLY,
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

			return toolResult('list_extensions', { data: result }, formatExtensionList(result))
		},
	)

	registerAppTool(
		server,
		'create_extension',
		{
			description: tools.create_extension.description,
			inputSchema: tools.create_extension.inputSchema.shape,
			annotations: MUTATE,
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
					return toolResult(
						'create_extension',
						{ id: args.id, already_enabled: true },
						formatConfirmation('Extension already enabled', args.id),
					)
				}

				const updatedSettings = buildEnableModuleSettings(args.id, settings)

				const result = await apiCall(
					config,
					'PATCH',
					`/api/workspaces/${args.workspace_id}`,
					{ settings: updatedSettings },
					{ workspaceId: args.workspace_id },
				)

				return toolResult(
					'create_extension',
					result,
					formatConfirmation('Enabled extension', args.id),
				)
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

			const typeNames = args.object_types.map((ot) => ot.type).join(', ')
			return toolResult(
				'create_extension',
				result,
				formatConfirmation('Created extension', `${args.id} with types: ${typeNames}`),
			)
		},
	)

	registerAppTool(
		server,
		'update_extension',
		{
			description: tools.update_extension.description,
			inputSchema: tools.update_extension.inputSchema.shape,
			annotations: MUTATE_IDEMPOTENT,
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

					return toolResult(
						'update_extension',
						result,
						formatConfirmation(args.enabled ? 'Enabled extension' : 'Disabled extension', args.id),
					)
				}

				if (args.enabled) {
					// Enable — check if it's a registered module
					const allModules = getAllModules()
					const mod = allModules.find((m) => m.id === args.id)
					if (mod) {
						if (enabledModules.includes(args.id)) {
							return toolResult(
								'update_extension',
								{ id: args.id, already_enabled: true },
								formatConfirmation('Extension already enabled', args.id),
							)
						}

						const updatedSettings = buildEnableModuleSettings(args.id, settings)

						const result = await apiCall(
							config,
							'PATCH',
							`/api/workspaces/${args.workspace_id}`,
							{ settings: updatedSettings },
							{ workspaceId: args.workspace_id },
						)

						return toolResult(
							'update_extension',
							result,
							formatConfirmation('Enabled extension', args.id),
						)
					}

					// Not a registered module or custom extension
					throw new Error(
						`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
					)
				}

				if (!enabledModules.includes(args.id)) {
					return toolResult(
						'update_extension',
						{ id: args.id, not_enabled: true },
						formatConfirmation('Extension not currently enabled', args.id),
					)
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

				return toolResult(
					'update_extension',
					result,
					formatConfirmation('Disabled extension', args.id),
				)
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

				return toolResult(
					'update_extension',
					result,
					formatConfirmation('Updated extension', args.id),
				)
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
			annotations: DESTRUCTIVE,
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

				return toolResult(
					'delete_extension',
					{ removed, workspace: result },
					formatConfirmation(
						'Deleted extension',
						`${args.id} (removed types: ${removed.join(', ')})`,
					),
				)
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

				return toolResult('delete_extension', result, formatConfirmation('Deleted type', args.id))
			}

			throw new Error(
				`Extension "${args.id}" not found. Call list_extensions to see available extensions.`,
			)
		},
	)

	// ─── Hello (Agent Welcome) ───────────────────────────────
	registerAppTool(
		server,
		'hello',
		{
			description: tools.hello.description,
			inputSchema: tools.hello.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: {},
		},
		async (args) => {
			let workspaceSection = ''
			let teamSection = ''

			// All API calls are best-effort — the tool works even without auth or workspace
			try {
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

				if (workspace) {
					const settings = workspace.settings ?? {}
					const statuses = (settings.statuses ?? {}) as Record<string, string[]>
					const fieldDefinitions = (settings.field_definitions ?? {}) as Record<
						string,
						Array<{
							name: string
							type: string
							required: boolean
							values?: string[]
						}>
					>
					const displayNames = (settings.display_names ?? {}) as Record<string, string>
					const relationshipTypes = (settings.relationship_types ?? []) as string[]
					const maxSessions = (settings.max_concurrent_sessions ?? 5) as number

					// Build workspace config section — derive types from settings keys
					const configuredTypes = new Set([
						...Object.keys(statuses),
						...Object.keys(fieldDefinitions),
						...Object.keys(displayNames),
					])
					const objectTypes =
						configuredTypes.size > 0 ? [...configuredTypes] : ['insight', 'bet', 'task']

					const typeLines: string[] = []
					for (const t of objectTypes) {
						const name = displayNames[t] ?? t.charAt(0).toUpperCase() + t.slice(1)
						const typeStatuses = statuses[t] ?? []
						const fields = fieldDefinitions[t] ?? []
						let line = `  • ${name} (type: "${t}")`
						if (typeStatuses.length > 0) {
							line += `\n    Statuses: ${typeStatuses.join(' → ')}`
						}
						if (fields.length > 0) {
							const fieldDesc = fields
								.map((f) => {
									let s = `${f.name} (${f.type}${f.required ? ', required' : ''})`
									if (f.values && f.values.length > 0) {
										s += ` [${f.values.join(', ')}]`
									}
									return s
								})
								.join(', ')
							line += `\n    Custom fields: ${fieldDesc}`
						}
						typeLines.push(line)
					}

					workspaceSection = `
📋 Your Workspace: "${workspace.name}"
   ID: ${workspace.id}

   Object Types:
${typeLines.join('\n')}

   Relationship Types: ${relationshipTypes.length > 0 ? relationshipTypes.join(', ') : 'informs, breaks_into, blocks, relates_to, duplicates (defaults)'}
   Max Concurrent Sessions: ${maxSessions}
${(() => {
	const enabledModules = (settings.enabled_modules ?? []) as string[]
	if (enabledModules.length === 0)
		return '   Extensions: none enabled (use create_extension to get started)'
	return `   Extensions: ${enabledModules.join(', ')}`
})()}`

					// Fetch team members
					try {
						const members = (await apiCall(
							config,
							'GET',
							`/api/workspaces/${workspace.id}/members`,
							undefined,
							{ workspaceId: workspace.id },
						)) as Array<{
							actorId: string
							name: string
							type: string
							role: string
						}>

						if (members.length > 0) {
							const memberLines = members.map(
								(m) => `  • ${m.name || 'Unnamed'} — ${m.type} (${m.role})`,
							)
							teamSection = `
👥 Your Team (${members.length} member${members.length === 1 ? '' : 's'})
${memberLines.join('\n')}`
						}
					} catch {
						// Members fetch is best-effort
					}
				} else {
					workspaceSection =
						'\n📋 No workspace found. Create one with create_workspace to get started!'
				}
			} catch {
				workspaceSection = `
📋 Workspace
   Not connected yet! To get your personalized workspace info:
   1. Use create_actor to sign up and get an API key
   2. Restart with API_KEY set, then call hello again
   3. Or pass a workspace_id if you have one`
			}

			const text = `🚀 Welcome to Maskin!

Hey there! Maskin is an AI-native product development platform where humans and agents collaborate side by side. Think of it as your mission control for turning insights into bets into shipped tasks — with full observability, real-time events, and automation built in.

Everything here is an API, and you're talking to it right now through MCP. Let's get you oriented!
${workspaceSection}
${teamSection}

🧰 Available Tools
${Object.keys(tools)
	.filter((t) => t !== 'hello')
	.map((t) => `   • ${t}`)
	.join('\n')}
${(() => {
	const extTools = getAllModules().flatMap((ext) =>
		(ext.mcpTools ?? []).map((t) => `   • ${ext.id}_${t.name} — [${ext.name}] ${t.description}`),
	)
	return extTools.length > 0 ? `\n🧩 Extension Tools\n${extTools.join('\n')}` : ''
})()}

⚡ Quick Start
  1. Call get_workspace_schema to see the full config for your workspace
  2. Use list_objects to see what's already in the workspace
  3. Use create_objects to add new insights, bets, or tasks
  4. Use search_objects to find things by keyword
  5. Check get_events to see what's been happening lately

Happy building! 🎉`

			return {
				_meta: { toolName: 'hello' },
				content: [{ type: 'text' as const, text }],
			}
		},
	)

	// ─── Workspace Dashboard ─────────────────────────────────
	registerAppTool(
		server,
		'workspace_dashboard',
		{
			description: tools.workspace_dashboard.description,
			inputSchema: tools.workspace_dashboard.inputSchema.shape,
			annotations: READ_ONLY,
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const wsOpts = { workspaceId: args.workspace_id }

			// Fetch all data in parallel
			const [workspaces, objects, events, sessions, members] = (await Promise.all([
				apiCall(config, 'GET', '/api/workspaces', undefined, { skipWorkspace: true }).catch(
					() => [],
				),
				apiCall(config, 'GET', '/api/objects?limit=50', undefined, wsOpts).catch(() => []),
				apiCall(config, 'GET', '/api/events/history?limit=20', undefined, wsOpts).catch(() => []),
				apiCall(config, 'GET', '/api/sessions?status=running', undefined, wsOpts).catch(() => []),
				apiCall(
					config,
					'GET',
					`/api/workspaces/${args.workspace_id ?? config.defaultWorkspaceId}/members`,
					undefined,
					{ skipWorkspace: true },
				).catch(() => []),
			])) as [
				Record<string, unknown>[],
				Record<string, unknown>[],
				Record<string, unknown>[],
				Record<string, unknown>[],
				Record<string, unknown>[],
			]

			const effectiveWsId = args.workspace_id ?? config.defaultWorkspaceId
			const workspace = effectiveWsId
				? (workspaces as Array<{ id: string }>).find((w) => w.id === effectiveWsId)
				: workspaces[0]

			const data = {
				workspace: workspace ?? {},
				objects: objects as Record<string, unknown>[],
				events: events as Record<string, unknown>[],
				sessions: sessions as Record<string, unknown>[],
				members: members as Record<string, unknown>[],
			}

			return toolResult('workspace_dashboard', data, formatDashboard(data))
		},
	)

	// ─── Prompts ─────────────────────────────────────────────
	server.registerPrompt(
		'workspace-overview',
		{
			title: 'Workspace Overview',
			description: 'Get oriented in the workspace — see types, schema, and recent objects',
		},
		() => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: "Give me an overview of my Maskin workspace.\nCall these tools in order:\n1. hello — get workspace config and team info\n2. list_objects (limit 10) — show recent objects\n3. get_workspace_schema — show the full type/status/field schema\nSummarize what you find: what types are configured, what's in the workspace, and who's on the team.",
					},
				},
			],
		}),
	)

	server.registerPrompt(
		'daily-standup',
		{
			title: 'Daily Standup',
			description: 'See recent activity, active work, and pending notifications',
		},
		() => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: "Give me a daily standup summary for my Maskin workspace.\nCall these tools in order:\n1. get_events (limit 20) — show what happened recently\n2. list_objects with status=in_progress or status=active (limit 20) — show active work\n3. list_notifications with status=pending — show unresolved notifications\nSummarize the findings as a concise standup report with sections: What happened, What's active, What needs attention.",
					},
				},
			],
		}),
	)

	server.registerPrompt(
		'review-task-backlog',
		{ title: 'Review Task Backlog', description: 'Review open tasks grouped by status' },
		() => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: 'Review the task backlog in my Maskin workspace.\nCall these tools:\n1. get_workspace_schema — see which statuses exist for tasks\n2. list_objects type=task — get all tasks\nGroup the tasks by status and summarize: how many in each status, which are stale, and what should be prioritized.',
					},
				},
			],
		}),
	)

	server.registerPrompt(
		'weekly-digest',
		{
			title: 'Weekly Digest',
			description: "Summarize the week's activity across objects and events",
		},
		() => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: 'Give me a weekly digest for my Maskin workspace.\nCall these tools:\n1. get_events (limit 100) — get recent activity\n2. list_objects (limit 50) — see current state of objects\n3. list_sessions (limit 20) — see recent agent sessions\nSummarize: what was created, updated, and completed this week. Highlight trends and notable changes.',
					},
				},
			],
		}),
	)

	server.registerPrompt(
		'relationship-map',
		{ title: 'Relationship Map', description: 'Understand how objects are connected' },
		() => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: 'Map out the relationships between objects in my Maskin workspace.\nCall these tools:\n1. list_objects (limit 30) — get the objects\n2. list_relationships — get all relationships\nDescribe the graph: which objects are connected, what relationship types exist, and identify any clusters or orphaned objects.',
					},
				},
			],
		}),
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
							_meta: { toolName: `${ext.id}_${tool.name}` },
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
	}

	const server = createMcpServer(config)
	const transport = new StdioServerTransport()
	await server.connect(transport)
	console.error('MCP server started (stdio transport)')
}

main().catch(console.error)
