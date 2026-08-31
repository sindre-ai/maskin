// MCP telemetry — fire-and-forget POSTs to /api/telemetry/mcp.
//
// Powers the bet's two success metrics (50% rich-render rate, 20% session-with-
// mutation rate). Every tool response goes through this; mutations are emitted
// in addition to the tool_call event when the tool is in MUTATION_TOOL_KINDS.
//
// Failures are logged once and otherwise swallowed: telemetry MUST NOT block or
// fail tool calls. Aggregation lives behind /api/telemetry/mcp/summary.

const { id: SESSION_ID, source: SESSION_SOURCE } = resolveSessionId()

let warned = false

// Monotonic per-process counter stamped onto every tool_call so the *order* of
// calls in a session can be reconstructed. Timestamps can't do this: events are
// fire-and-forget POSTs and can be ingested out of order.
let toolCallSeq = 0

function resolveSessionId(): { id: string; source: 'maskin-session' | 'process' } {
	// An MCP server launched by Maskin's own agent container inherits the
	// session uuid as `SESSION_ID` (set in session-manager.ts and listed in
	// agent-run.sh's reserved vars) — prefer it, so a stdio-launched server's
	// trace joins back to the `sessions` row exactly like the HTTP path does.
	//
	// `MASKIN_SESSION_ID` is honoured first purely as an explicit override for
	// a host that already uses `SESSION_ID` for something of its own. Read both
	// rather than only the namespaced name: nothing in this repo ever sets
	// `MASKIN_SESSION_ID`, so keying off it alone left this branch dead and
	// every containerised stdio server falling through to a random id.
	const fromEnv = (process.env.MASKIN_SESSION_ID ?? process.env.SESSION_ID)?.trim()
	if (fromEnv) return { id: fromEnv, source: 'maskin-session' }
	// Otherwise a per-process correlation id. For stdio this is exactly right:
	// one server process is one client session, for the life of the process.
	return {
		id: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
		source: 'process',
	}
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
	/** 1-based position of this call within the process's session. */
	seq?: number
	/** Sorted argument key NAMES. Never values — see `recordToolCall`. */
	arg_keys?: string[]
	/** False when the handler threw. */
	ok?: boolean
	/** Which transport the emitting server is exposed over. */
	transport?: 'stdio' | 'http'
	/**
	 * How `session_id` was obtained. `maskin-session` means it is a real
	 * `sessions.id` and joins back to the session row; `process` means it is
	 * this process's correlation id and only groups calls, it does not join.
	 * Sent because the ingest route cannot tell the two apart from the id.
	 */
	session_source?: 'maskin-session' | 'process'
}

export interface MutationEvent {
	event_type: 'mutation'
	tool_name: string
	session_id: string
	object_type?: string
	mutation_kind: string
}

export interface ToolCallResponseSizeEvent {
	event_type: 'tool_call_response_size'
	tool_name: string
	session_id: string
	content_bytes: number
	content_tokens: number
	structured_content_bytes: number
	structured_content_tokens: number
	truncated: boolean
}

// MCP misfire event for the agent-reach-signal bet. The server-side
// classifier in apps/dev/src/routes/mcp.ts owns the primary emission path;
// this type is here so clients that surface handler-thrown misfires (or
// downstream tests) speak the same shape as the server ingest.
export type McpMisfireKind = 'tool_not_found' | 'unknown_param' | 'schema_validation_error'

export interface ErrorEvent {
	event_type: 'error'
	kind: McpMisfireKind
	tool_name: string
	session_id: string
	agent_actor_id?: string
	requested_shape: Record<string, string>
}

export type TelemetryEvent = ToolCallEvent | MutationEvent | ToolCallResponseSizeEvent | ErrorEvent

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

/**
 * Reduce an arguments object to its sorted key names.
 *
 * Privacy contract: values are dropped entirely — not stringified, not typed,
 * not truncated. This is what lets the trace answer "which tools, in what
 * order, reaching for which fields" without carrying object titles, prompt
 * text, or comment bodies into analytics. Non-object arguments yield an empty
 * list rather than leaking their contents.
 */
// Mirrors `argKeysSchema` in @maskin/shared. Keys that don't fit are dropped
// here rather than sent and rejected downstream: the ingest boundary validates
// the whole event, so one odd key from a custom-extension tool would otherwise
// cost the entire telemetry row.
const ARG_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_ARG_KEYS = 64

export function argKeys(args: unknown): string[] {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return []
	return Object.keys(args as Record<string, unknown>)
		.filter((k) => ARG_KEY_RE.test(k))
		.sort()
		.slice(0, MAX_ARG_KEYS)
}

export function recordToolCall(
	sink: TelemetrySink,
	target: TelemetryConfig,
	event: {
		tool_name: string
		has_rich_render: boolean
		duration_ms: number
		workspace_id?: string
		args?: unknown
		ok?: boolean
		transport?: 'stdio' | 'http'
	},
): void {
	const cfg = event.workspace_id ? { ...target, workspaceId: event.workspace_id } : target
	toolCallSeq += 1
	sink(
		{
			event_type: 'tool_call',
			tool_name: event.tool_name,
			session_id: SESSION_ID,
			has_rich_render: event.has_rich_render,
			duration_ms: Math.max(0, Math.round(event.duration_ms)),
			seq: toolCallSeq,
			arg_keys: argKeys(event.args),
			ok: event.ok ?? true,
			transport: event.transport,
			session_source: SESSION_SOURCE,
		},
		cfg,
	)
}

// Cheap `bytes/4` token estimator. The response-scoping bet's First test only
// needs to rank tools by p95 — accuracy beyond that doesn't earn the cost of
// wiring a real tokenizer. T4's token cap is the place to revisit this.
export function estimateTokensFromBytes(bytes: number): number {
	if (bytes <= 0) return 0
	return Math.ceil(bytes / 4)
}

// Serialize an arbitrary tool-response payload to its on-the-wire JSON. Returns
// 0 bytes for null/undefined channels so a tool that omits `structuredContent`
// reports a clean zero instead of skewing the aggregate.
function measureJsonBytes(value: unknown): number {
	if (value === undefined || value === null) return 0
	try {
		const json = JSON.stringify(value)
		return json ? Buffer.byteLength(json, 'utf8') : 0
	} catch {
		return 0
	}
}

export function recordToolCallResponseSize(
	sink: TelemetrySink,
	target: TelemetryConfig,
	event: {
		tool_name: string
		content: unknown
		structured_content: unknown
		truncated: boolean
		workspace_id?: string
	},
): void {
	const cfg = event.workspace_id ? { ...target, workspaceId: event.workspace_id } : target
	const contentBytes = measureJsonBytes(event.content)
	const structuredBytes = measureJsonBytes(event.structured_content)
	sink(
		{
			event_type: 'tool_call_response_size',
			tool_name: event.tool_name,
			session_id: SESSION_ID,
			content_bytes: contentBytes,
			content_tokens: estimateTokensFromBytes(contentBytes),
			structured_content_bytes: structuredBytes,
			structured_content_tokens: estimateTokensFromBytes(structuredBytes),
			truncated: event.truncated,
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
	delete_relationship: 'relationship_delete',
	// Workspaces + members
	create_workspace: 'workspace_create',
	update_workspace: 'workspace_update',
	// Workspace schema (fields + enums)
	create_workspace_field: 'workspace_field_create',
	update_workspace_field: 'workspace_field_update',
	delete_workspace_field: 'workspace_field_delete',
	// Actors
	create_actor: 'actor_create',
	update_actor: 'actor_update',
	// Triggers
	create_trigger: 'trigger_create',
	update_trigger: 'trigger_update',
	delete_trigger: 'trigger_delete',
	// Loops
	create_loop: 'loop_create',
	update_loop: 'loop_update',
	delete_loop: 'loop_delete',
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

/** Resets the per-process tool-call sequence — only used in tests. */
export function __resetToolCallSeq(): void {
	toolCallSeq = 0
}

/** Exposes the per-process correlation id — only used in tests. */
export function __sessionId(): string {
	return SESSION_ID
}

/** Exposes how the session id was resolved — only used in tests. */
export function __sessionSource(): 'maskin-session' | 'process' {
	return SESSION_SOURCE
}
