import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAllModules, getModuleDefaultSettings } from '@maskin/module-sdk'
import {
	type CustomExtensionEntry,
	WORKSPACE_TEMPLATES,
	type WorkspaceTemplate,
	type WorkspaceTemplateId,
} from '@maskin/shared'
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
	type SessionLogSubscriptionRegistry,
	createSessionLogSubscriptionRegistry,
} from './session-log-subscriptions.js'
import {
	type EventFilter,
	type SubscriptionRegistry,
	createSubscriptionRegistry,
} from './subscriptions.js'
import { tools } from './tools.js'

interface McpConfig {
	apiBaseUrl: string
	apiKey: string
	defaultWorkspaceId: string
	/** Path to the directory containing built MCP app HTML files */
	htmlBasePath?: string
	/** Transport the server is exposed over. Tailors user-facing setup hints. */
	transport?: 'stdio' | 'http'
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
	options?: { skipAuth?: boolean; skipWorkspace?: boolean; workspaceId?: string },
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
		// stderr only — stdout is reserved for JSON-RPC on the stdio transport
		console.error(`[MCP] Loaded HTML resource: ${filename} (${html.length} bytes) from ${fullPath}`)
		return html
	} catch (err) {
		console.error(`[MCP] Failed to load HTML resource: ${fullPath}`, err)
		return '<html><body><p>MCP App UI not built yet. Run <code>pnpm --filter @maskin/web build:mcp</code> first.</p></body></html>'
	}
}

export function createMcpServer(config: McpConfig): {
	server: McpServer
	registry: SubscriptionRegistry
	eventRegistry: SubscriptionRegistry
	sessionLogRegistry: SessionLogSubscriptionRegistry
} {
	const server = new McpServer(
		{
			name: 'maskin',
			version: '0.1.0',
		},
		{
			capabilities: { logging: {} },
		},
	)
	const subscriptionRegistry = createSubscriptionRegistry(config, server)
	const sessionLogRegistry = createSessionLogSubscriptionRegistry(config, server)

	// ─── Register UI resources ─────────────────────────────────
	for (const [name, uri] of Object.entries(UI_RESOURCES)) {
		registerAppResource(server, `${name}-ui`, uri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
			// stderr only — stdout is reserved for JSON-RPC on the stdio transport
			console.error(`[MCP] Resource read requested: ${uri} (${name}.html)`)
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
			_meta: { ui: { resourceUri: UI_RESOURCES.objects, csp: CSP } },
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/graph', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: { toolName: 'create_objects' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
						return { id, success: true, result }
					} catch (error) {
						return { id, success: false, error: String(error) }
					}
				}),
			)
			return {
				_meta: { toolName: 'get_objects' },
				content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
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

			return {
				_meta: { toolName: 'update_objects' },
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
				_meta: { toolName: 'delete_object' },
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
			const params = new URLSearchParams()
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/objects?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'list_objects' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
			const params = new URLSearchParams()
			params.set('q', args.q)
			if (args.type) params.set('type', args.type)
			if (args.status) params.set('status', args.status)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/objects/search?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'search_objects' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
			const params = new URLSearchParams()
			if (args.source_id) params.set('source_id', args.source_id)
			if (args.target_id) params.set('target_id', args.target_id)
			if (args.type) params.set('type', args.type)
			const result = await apiCall(config, 'GET', `/api/relationships?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'list_relationships' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
				_meta: { toolName: 'delete_relationship' },
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

			return {
				_meta: { toolName: 'create_actor' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
		async () => {
			const result = await apiCall(config, 'GET', '/api/actors', undefined, {
				skipWorkspace: true,
			})
			return {
				_meta: { toolName: 'list_actors' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
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
			const result = await apiCall(config, 'GET', `/api/actors/${args.id}`, undefined, {
				skipWorkspace: true,
			})
			return {
				_meta: { toolName: 'get_actor' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
			const { id, ...body } = args
			const result = await apiCall(config, 'PATCH', `/api/actors/${id}`, body, {
				skipWorkspace: true,
			})
			return {
				_meta: { toolName: 'update_actor' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
				_meta: { toolName: 'regenerate_api_key' },
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
				_meta: { toolName: 'create_workspace' },
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
				_meta: { toolName: 'update_workspace' },
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
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async () => {
			const result = await apiCall(config, 'GET', '/api/workspaces', undefined, {
				skipWorkspace: true,
			})
			return {
				_meta: { toolName: 'list_workspaces' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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

			return {
				_meta: { toolName: 'get_workspace_schema' },
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
				_meta: { toolName: 'add_workspace_member' },
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
			if (args.entity_type) params.set('entity_type', args.entity_type)
			if (args.action) params.set('action', args.action)
			if (args.limit) params.set('limit', String(args.limit))
			const result = await apiCall(config, 'GET', `/api/events/history?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'get_events' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'subscribe_events',
		{
			description: tools.subscribe_events.description,
			inputSchema: tools.subscribe_events.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			if (!config.apiKey) {
				throw new Error(
					'Not authenticated. Use the create_actor tool first to sign up and get an API key, then restart the MCP server with API_KEY set.',
				)
			}
			const workspaceId = args.workspace_id ?? config.defaultWorkspaceId
			if (!workspaceId) {
				throw new Error(
					'No workspace specified. Either pass workspace_id to this tool, set DEFAULT_WORKSPACE_ID environment variable, or call list_workspaces to find your workspace ID.',
				)
			}
			const filter = (args.filter ?? {}) as EventFilter
			const sub = subscriptionRegistry.add(workspaceId, filter)
			return {
				_meta: { toolName: 'subscribe_events' },
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								subscription_id: sub.id,
								workspace_id: sub.workspaceId,
								filter: sub.filter,
								created_at: sub.createdAt,
								notice:
									'Live events will be delivered via MCP logging notifications with logger="maskin/events". Call unsubscribe_events to stop.',
							},
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
		'unsubscribe_events',
		{
			description: tools.unsubscribe_events.description,
			inputSchema: tools.unsubscribe_events.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async (args) => {
			const ok = subscriptionRegistry.remove(args.subscription_id)
			return {
				_meta: { toolName: 'unsubscribe_events' },
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ ok, subscription_id: args.subscription_id }, null, 2),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'list_event_subscriptions',
		{
			description: tools.list_event_subscriptions.description,
			inputSchema: tools.list_event_subscriptions.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.events, csp: CSP } },
		},
		async () => {
			const subs = subscriptionRegistry.list().map((s) => ({
				subscription_id: s.id,
				workspace_id: s.workspaceId,
				filter: s.filter,
				created_at: s.createdAt,
				events_delivered: s.eventsDelivered,
				events_dropped: s.eventsDropped,
			}))
			return {
				_meta: { toolName: 'list_event_subscriptions' },
				content: [{ type: 'text' as const, text: JSON.stringify(subs, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'subscribe_session_logs',
		{
			description: tools.subscribe_session_logs.description,
			inputSchema: tools.subscribe_session_logs.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			if (!config.apiKey) {
				throw new Error(
					'Not authenticated. Use the create_actor tool first to sign up and get an API key, then restart the MCP server with API_KEY set.',
				)
			}
			const workspaceId = args.workspace_id ?? config.defaultWorkspaceId
			if (!workspaceId) {
				throw new Error(
					'No workspace specified. Either pass workspace_id to this tool, set DEFAULT_WORKSPACE_ID environment variable, or call list_workspaces to find your workspace ID.',
				)
			}
			const sub = sessionLogRegistry.add(workspaceId, args.session_id)
			return {
				_meta: { toolName: 'subscribe_session_logs' },
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify(
							{
								subscription_id: sub.id,
								session_id: sub.sessionId,
								workspace_id: sub.workspaceId,
								created_at: sub.createdAt,
								notice:
									'Live logs will be delivered via MCP logging notifications with logger="maskin/session-logs". The subscription auto-removes when the session terminates. Call unsubscribe_session_logs to stop early.',
							},
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
		'unsubscribe_session_logs',
		{
			description: tools.unsubscribe_session_logs.description,
			inputSchema: tools.unsubscribe_session_logs.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const ok = sessionLogRegistry.remove(args.subscription_id)
			return {
				_meta: { toolName: 'unsubscribe_session_logs' },
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ ok, subscription_id: args.subscription_id }, null, 2),
					},
				],
			}
		},
	)

	registerAppTool(
		server,
		'list_session_log_subscriptions',
		{
			description: tools.list_session_log_subscriptions.description,
			inputSchema: tools.list_session_log_subscriptions.inputSchema.shape,
			_meta: {},
		},
		async () => {
			const subs = sessionLogRegistry.list().map((s) => ({
				subscription_id: s.id,
				session_id: s.sessionId,
				workspace_id: s.workspaceId,
				created_at: s.createdAt,
				logs_delivered: s.logsDelivered,
				logs_dropped: s.logsDropped,
			}))
			return {
				_meta: { toolName: 'list_session_log_subscriptions' },
				content: [{ type: 'text' as const, text: JSON.stringify(subs, null, 2) }],
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
			return {
				_meta: { toolName: 'create_trigger' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
			const result = await apiCall(config, 'GET', '/api/triggers', undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'list_triggers' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
			return {
				_meta: { toolName: 'update_trigger' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
				_meta: { toolName: 'delete_trigger' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	// ─── Notifications ────────────────────────────────────────
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
				_meta: { toolName: 'create_notification' },
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
				_meta: { toolName: 'list_notifications' },
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
				_meta: { toolName: 'get_notification' },
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
				_meta: { toolName: 'update_notification' },
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
				_meta: { toolName: 'delete_notification' },
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
			_meta: {},
		},
		async (args) => {
			const { workspace_id, ...body } = args
			const result = await apiCall(config, 'POST', '/api/sessions', body, {
				workspaceId: workspace_id,
			})
			return {
				_meta: { toolName: 'create_session' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'list_sessions',
		{
			description: tools.list_sessions.description,
			inputSchema: tools.list_sessions.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const params = new URLSearchParams()
			if (args.status) params.set('status', args.status)
			if (args.actor_id) params.set('actor_id', args.actor_id)
			if (args.limit) params.set('limit', String(args.limit))
			if (args.offset) params.set('offset', String(args.offset))
			const result = await apiCall(config, 'GET', `/api/sessions?${params}`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'list_sessions' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'get_session',
		{
			description: tools.get_session.description,
			inputSchema: tools.get_session.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const wsOpts = { workspaceId: args.workspace_id }
			const session = await apiCall(config, 'GET', `/api/sessions/${args.id}`, undefined, wsOpts)

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
					_meta: { toolName: 'get_session' },
					content: [{ type: 'text' as const, text: JSON.stringify({ session, logs }, null, 2) }],
				}
			}

			return {
				_meta: { toolName: 'get_session' },
				content: [{ type: 'text' as const, text: JSON.stringify(session, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'stop_session',
		{
			description: tools.stop_session.description,
			inputSchema: tools.stop_session.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/sessions/${args.id}/stop`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'stop_session' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'pause_session',
		{
			description: tools.pause_session.description,
			inputSchema: tools.pause_session.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/sessions/${args.id}/pause`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'pause_session' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'resume_session',
		{
			description: tools.resume_session.description,
			inputSchema: tools.resume_session.inputSchema.shape,
			_meta: {},
		},
		async (args) => {
			const result = await apiCall(config, 'POST', `/api/sessions/${args.id}/resume`, undefined, {
				workspaceId: args.workspace_id,
			})
			return {
				_meta: { toolName: 'resume_session' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
			}
		},
	)

	registerAppTool(
		server,
		'run_agent',
		{
			description: tools.run_agent.description,
			inputSchema: tools.run_agent.inputSchema.shape,
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
			const logs = await apiCall(
				config,
				'GET',
				`/api/sessions/${sessionId}/logs?limit=500`,
				undefined,
				wsOpts,
			)

			return {
				_meta: { toolName: 'run_agent' },
				content: [
					{ type: 'text' as const, text: JSON.stringify({ session: current, logs }, null, 2) },
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
				_meta: { toolName: 'list_integrations' },
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
				_meta: { toolName: 'list_integration_providers' },
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
				_meta: { toolName: 'connect_integration' },
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
				_meta: { toolName: 'disconnect_integration' },
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
				_meta: { toolName: 'set_llm_api_key' },
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
				_meta: { toolName: 'get_llm_api_keys' },
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
				_meta: { toolName: 'delete_llm_api_key' },
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
				_meta: { toolName: 'import_claude_subscription' },
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
				_meta: { toolName: 'get_claude_subscription_status' },
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
				_meta: { toolName: 'disconnect_claude_subscription' },
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
				_meta: { toolName: 'list_extensions' },
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
						_meta: { toolName: 'create_extension' },
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
					_meta: { toolName: 'create_extension' },
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
				_meta: { toolName: 'create_extension' },
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
						_meta: { toolName: 'update_extension' },
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
								_meta: { toolName: 'update_extension' },
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
							_meta: { toolName: 'update_extension' },
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
						_meta: { toolName: 'update_extension' },
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
					_meta: { toolName: 'update_extension' },
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
					_meta: { toolName: 'update_extension' },
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
					_meta: { toolName: 'delete_extension' },
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
					_meta: { toolName: 'delete_extension' },
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
				_meta: { toolName: 'get_started' },
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

			if (!args.confirm) {
				const previewLines: string[] = []
				const statuses = (template.settings.statuses ?? {}) as Record<string, string[]>
				const fields = (template.settings.field_definitions ?? {}) as Record<
					string,
					Array<{ name: string; type: string; values?: string[] }>
				>
				const displayNames = (template.settings.display_names ?? {}) as Record<string, string>
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
					{ settings: template.settings },
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

	return {
		server,
		registry: subscriptionRegistry,
		eventRegistry: subscriptionRegistry,
		sessionLogRegistry,
	}
}

// CLI entry point
async function main() {
	const config: McpConfig = {
		apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
		apiKey: process.env.API_KEY || '',
		defaultWorkspaceId: process.env.DEFAULT_WORKSPACE_ID || process.env.WORKSPACE_ID || '',
		transport: 'stdio',
	}

	const { server, eventRegistry, sessionLogRegistry } = createMcpServer(config)
	const transport = new StdioServerTransport()
	const shutdown = async () => {
		try {
			await Promise.all([eventRegistry.shutdownAll(), sessionLogRegistry.shutdownAll()])
		} catch (err) {
			console.error('[maskin-mcp] Error during shutdown:', err)
		}
	}
	transport.onclose = () => {
		void shutdown()
	}
	const handleSignal = (signal: NodeJS.Signals) => {
		console.error(`[maskin-mcp] Received ${signal}, shutting down`)
		void shutdown().then(() => process.exit(0))
	}
	process.on('SIGINT', handleSignal)
	process.on('SIGTERM', handleSignal)
	await server.connect(transport)
	console.error('MCP server started (stdio transport)')

	// Auto-subscribe to workspace notifications on startup so the agent always
	// sees user-facing messages (alert / recommendation / needs_input /
	// good_news) without having to remember to call subscribe_events. Only fires
	// in stdio mode — the HTTP transport is request-scoped so a subscription
	// here would be torn down immediately by the /mcp route's finally block.
	if (config.apiKey && config.defaultWorkspaceId) {
		try {
			const sub = eventRegistry.add(config.defaultWorkspaceId, {
				entity_type: ['notification'],
			})
			console.error(
				`[maskin-mcp] Auto-subscribed to notifications for workspace ${config.defaultWorkspaceId} (subscription ${sub.id})`,
			)
		} catch (err) {
			console.error(
				'[maskin-mcp] Failed to auto-subscribe to notifications:',
				err instanceof Error ? err.message : err,
			)
		}
	}
}

main().catch(console.error)
