// Maskin's own tools, split into a core that every agent lists and groups an agent lists only
// when it holds the grant for them. It changes what tools/list shows, never what a caller may
// do: a tool outside the core still runs when called by name.
//
// The core is picked from call counts per tool (PostHog, 29 Oct to 19 Nov 2026): a tool is core
// when 50 or more distinct agents called it or it has 2,000 or more estimated calls (desktop
// tools left out of that count), plus the four the agent prompts name for everyone
// (create_sub_chat, ask_user_question, get_started, post_conversation_message).
//
// A tool that is in neither the core nor a group stays listed, so a new tool is never hidden by
// accident. tool-groups.test.ts fails when a registered tool is in neither, so new tools get
// placed on purpose.

/** Name of the switch. Off or unset: every agent lists every tool, as before. */
export const TOOL_GROUPS_ENV_VAR = 'MASKIN_TOOL_GROUPS'

export const CORE_TOOLS: ReadonlySet<string> = new Set([
	'ask_user_question',
	'create_comment',
	'create_objects',
	'create_relationship',
	'create_sub_chat',
	'get_actor',
	'get_comments',
	'get_events',
	'get_file',
	'get_loop',
	'get_objects',
	'get_session',
	'get_started',
	'get_workspace_schema',
	'list_actors',
	'list_chats',
	'list_conversation_messages',
	'list_files',
	'list_for_you',
	'list_integrations',
	'list_loops',
	'list_notifications',
	'list_objects',
	'list_relationships',
	'list_sessions',
	'list_triggers',
	'list_unread',
	'list_workspaces',
	'post_conversation_message',
	'query_data',
	'search_objects',
	'update_notification',
	'update_objects',
	'update_trigger',
])

export const TOOL_GROUPS = {
	// The agent's own computer. Every desktop_* tool belongs here too (see groupOfTool).
	computer: ['show_computer'],
	automation: [
		'create_loop',
		'create_trigger',
		'delete_loop',
		'delete_trigger',
		'get_trigger',
		'schedule_next_step',
		'set_loop_view',
		'set_next_step',
		'update_loop',
		'update_next_step',
	],
	files: [
		'create_file',
		'delete_file',
		'list_file_tags',
		'merge_file_tags',
		'propose_file_changes',
		'rename_file_tag',
		'transcribe_file',
		'update_file',
	],
	sessions: [
		'get_session_activity',
		'get_session_logs',
		'pause_session',
		'resume_session',
		'send_session_message',
		'stop_session',
	],
	admin: [
		'add_mcp_server',
		'connect_integration',
		'create_actor',
		'create_extension',
		'create_workspace',
		'create_workspace_field',
		'delete_agent',
		'delete_extension',
		'delete_object',
		'delete_workspace_field',
		'disconnect_integration',
		'list_extensions',
		'list_integration_providers',
		'list_keychain_credentials',
		'request_integration_access',
		'request_keychain_access',
		'request_keychain_credential',
		'update_actor',
		'update_extension',
		'update_integration_access',
		'update_workspace',
		'update_workspace_field',
	],
	chats: [
		'add_chat_participant',
		'create_chat',
		'create_notification',
		'get_chat_activity',
		'get_conversation',
		'mark_read',
		'remove_chat_participant',
		'stop_chat_agent',
	],
	graph: ['delete_relationship', 'traverse_graph'],
	skills: [
		'create_workspace_skill',
		'delete_workspace_skill',
		'get_workspace_skill',
		'list_workspace_skills',
		'update_workspace_skill',
	],
	decisions: [
		'approve_draft_from_chat',
		'approve_object_draft',
		'record_go_ahead',
		'skip_done_when',
		'take_back_go_ahead',
		'withdraw_decision_card',
	],
	email: ['gmail_save_attachment', 'gmail_send_email', 'resend_send_email'],
} as const satisfies Record<string, readonly string[]>

export type ToolGroup = keyof typeof TOOL_GROUPS

export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[]

const GROUP_BY_TOOL: ReadonlyMap<string, ToolGroup> = new Map(
	TOOL_GROUP_NAMES.flatMap((group) => TOOL_GROUPS[group].map((tool) => [tool, group] as const)),
)

/** The group a tool belongs to, or undefined for a core tool and for one nobody has placed. */
export function groupOfTool(name: string): ToolGroup | undefined {
	if (name.startsWith('desktop_')) return 'computer'
	return GROUP_BY_TOOL.get(name)
}

/** True when the switch is on. Only "true" or "1" turns it on, so unset is the rollback. */
export function isToolGroupsEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return ['true', '1'].includes(env[TOOL_GROUPS_ENV_VAR]?.trim().toLowerCase() ?? '')
}

/**
 * The groups an agent holds, read from the `maskin_tool_groups` list on its tools config.
 * Undefined means the agent has no list yet (never seeded), which lists every tool, so turning
 * the switch on cannot take a tool from an agent nobody has looked at. Names that are not a
 * group are dropped.
 */
export function readGrantedToolGroups(tools: unknown): ToolGroup[] | undefined {
	if (typeof tools !== 'object' || tools === null) return undefined
	const raw = (tools as Record<string, unknown>).maskin_tool_groups
	if (!Array.isArray(raw)) return undefined
	return TOOL_GROUP_NAMES.filter((group) => raw.includes(group))
}

/** True when tools/list should leave this tool out for a caller holding `granted`. */
export function isToolHidden(name: string, granted: readonly string[]): boolean {
	const group = groupOfTool(name)
	return group !== undefined && !granted.includes(group)
}

/** The groups that hold at least one of these tool names. Core and unknown names add nothing. */
export function groupsForToolNames(names: Iterable<string>): ToolGroup[] {
	const held = new Set<ToolGroup>()
	for (const name of names) {
		const group = groupOfTool(name)
		if (group) held.add(group)
	}
	return TOOL_GROUP_NAMES.filter((group) => held.has(group))
}

/** Grouped tool names written out in a text (an agent prompt, a skill, a trigger prompt). */
export function groupedToolNamesIn(text: string): string[] {
	const found = new Set<string>()
	for (const match of text.matchAll(/\b(desktop_[a-z_]+|[a-z]+(?:_[a-z]+)+)\b/g)) {
		const name = match[1] as string
		if (groupOfTool(name)) found.add(name)
	}
	return [...found]
}
