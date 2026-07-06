// MCP telemetry — fire-and-forget POSTs to /api/telemetry/mcp.
//
// Powers the bet's two success metrics (50% rich-render rate, 20% session-with-
// mutation rate). Every tool response goes through this; mutations are emitted
// in addition to the tool_call event when the tool is in MUTATION_TOOL_KINDS.
//
// Failures are logged once and otherwise swallowed: telemetry MUST NOT block or
// fail tool calls. Aggregation lives behind /api/telemetry/mcp/summary.

const SESSION_ID = randomCorrelationId()

let warned = false

function randomCorrelationId(): string {
	// Per-process correlation id used when the upstream MCP transport doesn't
	// surface a session id (stdio transport in particular). Stable for the
	// lifetime of the process so per-session aggregation is meaningful.
	return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface TelemetryConfig {
	apiBaseUrl: string
	apiKey: string
	workspaceId?: string
}

export interface ToolCallEvent {
	event_type: 'tool_call'
	tool_name: string
	session_id: string
	has_rich_render: boolean
	duration_ms: number
}

export interface MutationEvent {
	event_type: 'mutation'
	tool_name: string
	session_id: string
	object_type?: string
	mutation_kind: string
}

export interface WidgetEvent {
	event_type: 'widget_event'
	widget_name: string
	event: 'click_through' | 'render_success' | 'render_error'
	tool_name: string
	object_type?: string
	object_id?: string
	card_kind: 'single' | 'list' | 'empty'
	session_id: string
	ts: number
}

// Response-size instrumentation for the MCP response-shape bet. `response_bytes`
// is `Buffer.byteLength(JSON.stringify(response), 'utf8')` over the full tool
// response object (content, structuredContent, _meta). `has_include` reports
// whether the caller passed a non-empty `include` array — the ship metric splits
// medians by this flag so the default-fields trim can be measured independently
// of opt-in expansions.
export interface ToolResponseEmittedEvent {
	event_type: 'tool_response_emitted'
	tool_name: string
	session_id: string
	response_bytes: number
	has_include: boolean
}

export type TelemetryEvent = ToolCallEvent | MutationEvent | WidgetEvent | ToolResponseEmittedEvent

/** A telemetry sink ingests events. Production default POSTs to the API; tests
 *  inject capturing sinks; deployments without telemetry endpoints can pass a
 *  noop. */
export type TelemetrySink = (event: TelemetryEvent, target: TelemetryConfig) => void

export function createDefaultSink(): TelemetrySink {
	return (event, target) => {
		if (!target.apiBaseUrl || !target.apiKey || !target.workspaceId) return
		void postEvent(event, target)
	}
}

async function postEvent(event: TelemetryEvent, target: TelemetryConfig): Promise<void> {
	try {
		const response = await fetch(`${target.apiBaseUrl}/api/telemetry/mcp`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${target.apiKey}`,
				'X-Workspace-Id': target.workspaceId ?? '',
			},
			body: JSON.stringify(event),
		})
		if (!response.ok && !warned) {
			warned = true
			console.error(
				`[MCP telemetry] POST /api/telemetry/mcp returned ${response.status}; further telemetry errors will be suppressed.`,
			)
		}
	} catch (err) {
		if (!warned) {
			warned = true
			console.error('[MCP telemetry] failed to record event:', err)
		}
	}
}

export function recordToolCall(
	sink: TelemetrySink,
	target: TelemetryConfig,
	event: {
		tool_name: string
		has_rich_render: boolean
		duration_ms: number
		workspace_id?: string
	},
): void {
	const cfg = event.workspace_id ? { ...target, workspaceId: event.workspace_id } : target
	sink(
		{
			event_type: 'tool_call',
			tool_name: event.tool_name,
			session_id: SESSION_ID,
			has_rich_render: event.has_rich_render,
			duration_ms: Math.max(0, Math.round(event.duration_ms)),
		},
		cfg,
	)
}

export function recordWidgetEvent(
	sink: TelemetrySink,
	target: TelemetryConfig,
	event: {
		widget_name: string
		event: 'click_through' | 'render_success' | 'render_error'
		tool_name: string
		card_kind: 'single' | 'list' | 'empty'
		object_type?: string
		object_id?: string
		workspace_id?: string
	},
): void {
	const cfg = event.workspace_id ? { ...target, workspaceId: event.workspace_id } : target
	sink(
		{
			event_type: 'widget_event',
			widget_name: event.widget_name,
			event: event.event,
			tool_name: event.tool_name,
			object_type: event.object_type,
			object_id: event.object_id,
			card_kind: event.card_kind,
			session_id: SESSION_ID,
			ts: Date.now(),
		},
		cfg,
	)
}

export function recordToolResponseEmitted(
	sink: TelemetrySink,
	target: TelemetryConfig,
	event: {
		tool_name: string
		response_bytes: number
		has_include: boolean
		workspace_id?: string
	},
): void {
	const cfg = event.workspace_id ? { ...target, workspaceId: event.workspace_id } : target
	sink(
		{
			event_type: 'tool_response_emitted',
			tool_name: event.tool_name,
			session_id: SESSION_ID,
			response_bytes: Math.max(0, Math.round(event.response_bytes)),
			has_include: event.has_include,
		},
		cfg,
	)
}

export function recordMutation(
	sink: TelemetrySink,
	target: TelemetryConfig,
	event: {
		tool_name: string
		mutation_kind: string
		object_type?: string
		workspace_id?: string
	},
): void {
	const cfg = event.workspace_id ? { ...target, workspaceId: event.workspace_id } : target
	sink(
		{
			event_type: 'mutation',
			tool_name: event.tool_name,
			session_id: SESSION_ID,
			object_type: event.object_type,
			mutation_kind: event.mutation_kind,
		},
		cfg,
	)
}

// Tools whose successful responses count as in-chat mutations for the bet's
// 20%-of-sessions metric. F4's mutation surface dispatches through these MCP
// tool names, so card-driven actions and agent-driven calls land here together.
// The mutation_kind label is what the dashboard groups by.
//
// Coverage: every MCP tool that produces a server-side write is listed here.
// Read-only tools (list_*, get_*, search_*, get_workspace_schema, etc.) are
// intentionally excluded.
export const MUTATION_TOOL_KINDS: Record<string, string> = {
	// Objects + relationships
	create_objects: 'create',
	update_objects: 'update',
	delete_object: 'delete',
	create_relationship: 'relationship_create',
	delete_relationship: 'relationship_delete',
	// Workspaces + members
	create_workspace: 'workspace_create',
	update_workspace: 'workspace_update',
	add_workspace_member: 'workspace_member_add',
	// Workspace schema (fields + enums)
	create_workspace_field: 'workspace_field_create',
	update_workspace_field: 'workspace_field_update',
	delete_workspace_field: 'workspace_field_delete',
	add_workspace_enum_value: 'workspace_enum_add',
	remove_workspace_enum_value: 'workspace_enum_remove',
	// Actors
	create_actor: 'actor_create',
	update_actor: 'actor_update',
	regenerate_api_key: 'actor_api_key_rotate',
	// Triggers
	create_trigger: 'trigger_create',
	update_trigger: 'trigger_update',
	delete_trigger: 'trigger_delete',
	// Notifications
	create_notification: 'notification_create',
	update_notification: 'notification_update',
	delete_notification: 'notification_delete',
	// Comments
	create_comment: 'comment_create',
	// Workspace skills
	create_workspace_skill: 'skill_create',
	update_workspace_skill: 'skill_update',
	delete_workspace_skill: 'skill_delete',
	// Files
	create_file: 'file_create',
	update_file: 'file_update',
	delete_file: 'file_delete',
	// Extensions / modules
	create_extension: 'extension_create',
	update_extension: 'extension_update',
	delete_extension: 'extension_delete',
	// LLM API keys
	set_llm_api_key: 'llm_key_set',
	delete_llm_api_key: 'llm_key_delete',
	// Claude subscription
	import_claude_subscription: 'claude_subscription_import',
	disconnect_claude_subscription: 'claude_subscription_disconnect',
	// Integrations
	connect_integration: 'integration_connect',
	disconnect_integration: 'integration_disconnect',
	// Sessions
	create_session: 'session_create',
	stop_session: 'session_stop',
	pause_session: 'session_pause',
	resume_session: 'session_resume',
	run_agent: 'session_run',
}

/** Resets the warned flag — only used in tests. */
export function __resetTelemetryWarnedFlag(): void {
	warned = false
}

/** Exposes the per-process correlation id — only used in tests. */
export function __sessionId(): string {
	return SESSION_ID
}
