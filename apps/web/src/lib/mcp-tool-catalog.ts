export interface McpToolEntry {
	category: string
	name: string
	description: string
	annotation?: 'read' | 'write' | 'destructive' | 'side-effect'
}

/**
 * Static catalog of Maskin MCP tools for display in the UI.
 * Extracted from packages/mcp/src/tools.ts — kept intentionally concise.
 */
export const MASKIN_TOOL_CATALOG: McpToolEntry[] = [
	// Welcome
	{
		category: 'General',
		name: 'hello',
		description: 'Get workspace overview, team, and available tools',
		annotation: 'read',
	},
	{
		category: 'General',
		name: 'workspace_dashboard',
		description: 'Comprehensive workspace overview in a single call',
		annotation: 'read',
	},

	// Objects
	{
		category: 'Objects',
		name: 'create_objects',
		description: 'Create objects with optional relationships',
		annotation: 'write',
	},
	{
		category: 'Objects',
		name: 'get_objects',
		description: 'Get objects by ID with full relationship graph',
		annotation: 'read',
	},
	{
		category: 'Objects',
		name: 'update_objects',
		description: 'Update objects and create relationships',
		annotation: 'write',
	},
	{
		category: 'Objects',
		name: 'delete_object',
		description: 'Delete an object by ID',
		annotation: 'destructive',
	},
	{
		category: 'Objects',
		name: 'list_objects',
		description: 'List and filter objects by type, status, or owner',
		annotation: 'read',
	},
	{
		category: 'Objects',
		name: 'search_objects',
		description: 'Full-text search on title and content',
		annotation: 'read',
	},

	// Relationships
	{
		category: 'Relationships',
		name: 'list_relationships',
		description: 'List relationships with filters',
		annotation: 'read',
	},
	{
		category: 'Relationships',
		name: 'delete_relationship',
		description: 'Delete a relationship by ID',
		annotation: 'destructive',
	},

	// Actors
	{
		category: 'Actors',
		name: 'create_actor',
		description: 'Create a human or agent actor',
		annotation: 'write',
	},
	{
		category: 'Actors',
		name: 'list_actors',
		description: 'List all actors in the workspace',
		annotation: 'read',
	},
	{
		category: 'Actors',
		name: 'get_actor',
		description: 'Get actor details by ID',
		annotation: 'read',
	},
	{
		category: 'Actors',
		name: 'update_actor',
		description: 'Update actor config, tools, or memory',
		annotation: 'write',
	},

	// Workspaces
	{
		category: 'Workspaces',
		name: 'list_workspaces',
		description: 'List accessible workspaces',
		annotation: 'read',
	},
	{
		category: 'Workspaces',
		name: 'get_workspace_schema',
		description: 'Get types, statuses, fields, and relationship types',
		annotation: 'read',
	},
	{
		category: 'Workspaces',
		name: 'add_workspace_member',
		description: 'Add an actor to a workspace',
		annotation: 'write',
	},

	// Sessions
	{
		category: 'Sessions',
		name: 'create_session',
		description: 'Spawn a containerized agent session',
		annotation: 'side-effect',
	},
	{
		category: 'Sessions',
		name: 'run_agent',
		description: 'Create session, wait for completion, return logs',
		annotation: 'side-effect',
	},
	{
		category: 'Sessions',
		name: 'list_sessions',
		description: 'List sessions with status and actor filters',
		annotation: 'read',
	},
	{
		category: 'Sessions',
		name: 'get_session',
		description: 'Get session details and optionally logs',
		annotation: 'read',
	},
	{
		category: 'Sessions',
		name: 'stop_session',
		description: 'Stop a running session',
		annotation: 'destructive',
	},
	{
		category: 'Sessions',
		name: 'pause_session',
		description: 'Pause session and save snapshot',
		annotation: 'write',
	},

	// Notifications
	{
		category: 'Notifications',
		name: 'create_notification',
		description: 'Create notification for human (needs_input, recommendation, alert, good_news)',
		annotation: 'write',
	},
	{
		category: 'Notifications',
		name: 'list_notifications',
		description: 'List notifications filtered by status or type',
		annotation: 'read',
	},

	// Triggers
	{
		category: 'Triggers',
		name: 'create_trigger',
		description: 'Create cron or event-based automation',
		annotation: 'write',
	},
	{
		category: 'Triggers',
		name: 'list_triggers',
		description: 'List all triggers in workspace',
		annotation: 'read',
	},

	// Integrations
	{
		category: 'Integrations',
		name: 'connect_integration',
		description: 'Start OAuth connection for a provider',
		annotation: 'side-effect',
	},
	{
		category: 'Integrations',
		name: 'list_integrations',
		description: 'List connected integrations',
		annotation: 'read',
	},

	// Extensions
	{
		category: 'Extensions',
		name: 'list_extensions',
		description: 'List available and enabled extensions',
		annotation: 'read',
	},
	{
		category: 'Extensions',
		name: 'create_extension',
		description: 'Enable or create a custom extension',
		annotation: 'write',
	},

	// Events
	{
		category: 'Events',
		name: 'get_events',
		description: 'Get workspace activity log',
		annotation: 'read',
	},
]

/** Group tools by category for display */
export function groupToolsByCategory(tools: McpToolEntry[]): Map<string, McpToolEntry[]> {
	const groups = new Map<string, McpToolEntry[]>()
	for (const tool of tools) {
		const group = groups.get(tool.category) ?? []
		group.push(tool)
		groups.set(tool.category, group)
	}
	return groups
}
