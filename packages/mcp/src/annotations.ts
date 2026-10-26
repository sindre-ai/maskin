/**
 * Title and behaviour annotations for the platform MCP tools.
 *
 * The registerAppTool wrapper in server.ts looks each tool up here by name and
 * adds `title` and `annotations` to its definition, so every client sees them in
 * tools/list. They are hints for the client (labels, permission prompts), not
 * enforcement.
 *
 * Extension tools are registered as `${ext.id}_${tool.name}` at runtime. They are
 * dynamic, have no entry here, and are not annotated.
 *
 * This table is deliberately separate from READ_TOOL_NAMES (read-error.ts) and
 * MUTATION_TOOL_KINDS (telemetry.ts). READ_TOOL_NAMES also decides whether a
 * thrown handler error becomes a structured error response or is re-thrown, so
 * it must not be edited or derived from to add a label. surface-pin.test.ts keeps
 * all three in step: every registered tool has a row, every row is a registered
 * tool, and no MUTATION_TOOL_KINDS tool is read-only.
 */

export interface ToolAnnotationEntry {
	title: string
	readOnlyHint: boolean
	destructiveHint: boolean
	idempotentHint: boolean
	openWorldHint: boolean
}

/**
 * Tools that only read. Not READ_TOOL_NAMES: get_started is in that set but its
 * confirm path installs a loop, so it is not read-only here; and the four tools at
 * the end read without being in that set (they keep re-throwing on error).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	'get_objects',
	'list_objects',
	'search_objects',
	'list_relationships',
	'list_actors',
	'get_actor',
	'list_workspaces',
	'get_workspace_schema',
	'list_workspace_skills',
	'get_workspace_skill',
	'list_files',
	'get_file',
	'get_events',
	'get_comments',
	'list_triggers',
	'list_loops',
	'get_loop',
	'list_unread',
	'list_sessions',
	'get_session',
	'list_integrations',
	'list_integration_providers',
	'list_extensions',
	'get_session_logs',
	'traverse_graph',
	'get_conversation',
	'list_chats',
	'list_conversation_messages',
	'get_session_activity',
	'get_chat_activity',
	'list_notifications',
	'list_keychain_credentials',
	'desktop_list_ports',
])

interface Row {
	title: string
	destructive: boolean
	idempotent: boolean
	openWorld: boolean
}

function row(
	title: string,
	flags: { destructive?: true; idempotent?: true; openWorld?: true } = {},
): Row {
	return {
		title,
		destructive: flags.destructive ?? false,
		idempotent: flags.idempotent ?? false,
		openWorld: flags.openWorld ?? false,
	}
}

// destructive: delete_*, stop_session, stop_chat_agent, disconnect_integration, desktop_run (runs any command).
// idempotent: update_*, delete_*, pause_session, mark_read.
// openWorld: create_session, create_sub_chat and create_chat (start an agent), the integration tools, and the two tools that
// send a message out (gmail_send_email, approve_object_draft).
const ROWS: Record<string, Row> = {
	// Objects + relationships
	create_objects: row('Create objects'),
	get_objects: row('Get objects'),
	update_objects: row('Update objects', { idempotent: true }),
	delete_object: row('Delete object', { destructive: true, idempotent: true }),
	list_objects: row('List objects'),
	search_objects: row('Search objects'),
	create_relationship: row('Create relationship'),
	list_relationships: row('List relationships'),
	traverse_graph: row('Traverse graph'),
	delete_relationship: row('Delete relationship', { destructive: true, idempotent: true }),
	// Actors
	create_actor: row('Create actor'),
	list_actors: row('List actors'),
	get_actor: row('Get actor'),
	update_actor: row('Update actor', { idempotent: true }),
	// Workspaces
	create_workspace: row('Create workspace'),
	update_workspace: row('Update workspace', { idempotent: true }),
	list_workspaces: row('List workspaces'),
	get_workspace_schema: row('Get workspace schema'),
	create_workspace_field: row('Create workspace field'),
	update_workspace_field: row('Update workspace field', { idempotent: true }),
	delete_workspace_field: row('Delete workspace field', { destructive: true, idempotent: true }),
	// Workspace skills
	list_workspace_skills: row('List workspace skills'),
	get_workspace_skill: row('Get workspace skill'),
	create_workspace_skill: row('Create workspace skill'),
	update_workspace_skill: row('Update workspace skill', { idempotent: true }),
	delete_workspace_skill: row('Delete workspace skill', { destructive: true, idempotent: true }),
	// Files
	create_file: row('Create file'),
	list_files: row('List files'),
	get_file: row('Get file'),
	update_file: row('Update file', { idempotent: true }),
	delete_file: row('Delete file', { destructive: true, idempotent: true }),
	// Events + comments + conversations
	get_events: row('Get events'),
	get_comments: row('Get comments'),
	create_comment: row('Create comment'),
	get_conversation: row('Get conversation'),
	list_chats: row('List chats'),
	list_conversation_messages: row('List conversation messages'),
	post_conversation_message: row('Post conversation message'),
	create_chat: row('Create chat', { openWorld: true }),
	add_chat_participant: row('Add chat participant'),
	remove_chat_participant: row('Remove chat participant'),
	get_chat_activity: row('Get chat activity'),
	stop_chat_agent: row('Stop chat agent', { destructive: true }),
	// Triggers
	create_trigger: row('Create trigger'),
	list_triggers: row('List triggers'),
	update_trigger: row('Update trigger', { idempotent: true }),
	delete_trigger: row('Delete trigger', { destructive: true, idempotent: true }),
	// Loops
	create_loop: row('Create loop'),
	update_loop: row('Update loop', { idempotent: true }),
	list_loops: row('List loops'),
	get_loop: row('Get loop'),
	delete_loop: row('Delete loop', { destructive: true, idempotent: true }),
	// Subscriptions
	mark_read: row('Mark read', { idempotent: true }),
	list_unread: row('List unread'),
	// Sessions
	create_session: row('Create session', { openWorld: true }),
	create_sub_chat: row('Create sub-chat', { openWorld: true }),
	list_sessions: row('List sessions'),
	get_session: row('Get session'),
	get_session_logs: row('Get session logs'),
	stop_session: row('Stop session', { destructive: true }),
	pause_session: row('Pause session', { idempotent: true }),
	resume_session: row('Resume session'),
	send_session_message: row('Send session message'),
	ask_user_question: row('Ask user question'),
	// Integrations
	list_integrations: row('List integrations', { openWorld: true }),
	list_integration_providers: row('List integration providers', { openWorld: true }),
	connect_integration: row('Connect integration', { openWorld: true }),
	disconnect_integration: row('Disconnect integration', { destructive: true, openWorld: true }),
	// Extensions
	list_extensions: row('List extensions'),
	create_extension: row('Create extension'),
	update_extension: row('Update extension', { idempotent: true }),
	delete_extension: row('Delete extension', { destructive: true, idempotent: true }),
	// Notifications
	create_notification: row('Create notification'),
	list_notifications: row('List notifications'),
	update_notification: row('Update notification', { idempotent: true }),
	// Session activity, drafts, mail and access
	get_session_activity: row('Get session activity'),
	approve_object_draft: row('Approve object draft', { openWorld: true }),
	gmail_send_email: row('Send Gmail email', { openWorld: true }),
	update_integration_access: row('Update integration access', {
		idempotent: true,
		openWorld: true,
	}),
	// Keychain + chat cards
	request_keychain_credential: row('Request keychain credential'),
	list_keychain_credentials: row('List keychain credentials'),
	request_keychain_access: row('Request keychain access'),
	request_integration_access: row('Request integration access'),
	show_computer: row('Show computer'),
	// Workspace desktop
	desktop_screenshot: row('Desktop screenshot'),
	desktop_click: row('Desktop click'),
	desktop_move: row('Desktop move'),
	desktop_drag: row('Desktop drag'),
	desktop_scroll: row('Desktop scroll'),
	desktop_type: row('Desktop type'),
	desktop_key: row('Desktop key'),
	desktop_run: row('Desktop run command', { destructive: true }),
	desktop_expose_port: row('Desktop expose port'),
	desktop_list_ports: row('Desktop list ports'),
	desktop_close_port: row('Desktop close port'),
	// Setup
	get_started: row('Get started'),
}

export const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotationEntry>> = Object.freeze(
	Object.fromEntries(
		Object.entries(ROWS).map(([name, r]) => [
			name,
			{
				title: r.title,
				readOnlyHint: READ_ONLY_TOOLS.has(name),
				destructiveHint: r.destructive,
				idempotentHint: r.idempotent,
				openWorldHint: r.openWorld,
			},
		]),
	),
)
