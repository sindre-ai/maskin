import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
	registerAppTool,
} from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getObjectTypes, type ObjectTypeDefinition } from '@ai-native/shared'
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
	objects: 'ui://ai-native/objects',
	relationships: 'ui://ai-native/relationships',
	actors: 'ui://ai-native/actors',
	workspaces: 'ui://ai-native/workspaces',
	events: 'ui://ai-native/events',
	triggers: 'ui://ai-native/triggers',
	graph: 'ui://ai-native/graph',
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

function loadHtml(config: McpConfig, filename: string): string {
	const basePath = config.htmlBasePath ?? resolve(__dirname, '../../../apps/web/dist-mcp')
	const fullPath = resolve(basePath, filename)
	try {
		const html = readFileSync(fullPath, 'utf-8')
		console.log(`[MCP] Loaded HTML resource: ${filename} (${html.length} bytes) from ${fullPath}`)
		return html
	} catch (err) {
		console.error(`[MCP] Failed to load HTML resource: ${fullPath}`, err)
		return '<html><body><p>MCP App UI not built yet. Run <code>pnpm --filter @ai-native/web build:mcp</code> first.</p></body></html>'
	}
}

export function createMcpServer(config: McpConfig) {
	const server = new McpServer({
		name: 'ai-native-oss',
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
			const relationshipTypes = (settings.relationship_types ?? []) as string[]
			const typeFilter = args.type

			const allTypes = getObjectTypes(settings as Parameters<typeof getObjectTypes>[0])
			const filteredTypes = typeFilter ? allTypes.filter((t) => t.slug === typeFilter) : allTypes

			const schema: Record<string, unknown> = {
				workspace_id: workspace.id,
				workspace_name: workspace.name,
				relationship_types: relationshipTypes,
			}

			const typeSchemas: Record<string, unknown> = {}
			for (const t of filteredTypes as ObjectTypeDefinition[]) {
				typeSchemas[t.slug] = {
					display_name: t.display_name,
					icon: t.icon,
					color: t.color,
					statuses: t.statuses,
					default_status: t.default_status ?? t.statuses[0],
					fields: t.field_definitions ?? [],
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
		'manage_object_types',
		{
			description: tools.manage_object_types.description,
			inputSchema: tools.manage_object_types.inputSchema.shape,
			_meta: { ui: { resourceUri: UI_RESOURCES.workspaces, csp: CSP } },
		},
		async (args) => {
			const workspaceId = args.workspace_id ?? config.defaultWorkspaceId
			if (args.action === 'delete') {
				const url = `/api/workspaces/${workspaceId}/types/${args.slug}${args.force ? '?force=true' : ''}`
				const result = await apiCall(config, 'DELETE', url, undefined, { skipWorkspace: true })
				return {
					_meta: { toolName: 'manage_object_types' },
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
				}
			}
			// upsert
			const body = {
				slug: args.slug,
				display_name: args.display_name ?? args.slug,
				icon: args.icon,
				color: args.color,
				statuses: args.statuses ?? [],
				default_status: args.default_status,
				field_definitions: args.field_definitions ?? [],
				source: 'custom' as const,
			}
			const result = await apiCall(
				config,
				'PUT',
				`/api/workspaces/${workspaceId}/types/${args.slug}`,
				body,
				{ skipWorkspace: true },
			)
			return {
				_meta: { toolName: 'manage_object_types' },
				content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
