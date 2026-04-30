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

export type TelemetryEvent = ToolCallEvent | MutationEvent

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
export const MUTATION_TOOL_KINDS: Record<string, string> = {
	create_objects: 'create',
	update_objects: 'update',
	delete_object: 'delete',
	create_relationship: 'relationship_create',
	delete_relationship: 'relationship_delete',
	update_workspace: 'workspace_update',
	create_actor: 'actor_create',
	update_actor: 'actor_update',
	create_trigger: 'trigger_create',
	update_trigger: 'trigger_update',
	delete_trigger: 'trigger_delete',
	create_notification: 'notification_create',
	update_notification: 'notification_update',
	delete_notification: 'notification_delete',
}

/** Resets the warned flag — only used in tests. */
export function __resetTelemetryWarnedFlag(): void {
	warned = false
}

/** Exposes the per-process correlation id — only used in tests. */
export function __sessionId(): string {
	return SESSION_ID
}
