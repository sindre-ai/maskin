import type { PosthogEventProps } from './posthog'
import { capturePosthogEvent } from './posthog'

// One PostHog event per Maskin MCP tool call, for reconstructing *which tools
// an agent called, in what order*, within a session. Filter to one
// `session_id`, sort by `seq`, and you have the call sequence.
//
// Privacy contract — this is the whole point of the event's shape: no argument
// VALUES and no result content ever land here. `arg_keys` is the sorted list of
// argument key NAMES and nothing else (see `argKeys` below), which is enough to
// tell a broad `list_objects` from a narrow one without carrying titles, prompt
// text, or comment bodies into analytics. Anything added to this payload later
// must clear the same bar; `mcp-tool-calls.test.ts` asserts it.
export const MCP_TOOL_CALL_EVENT = 'mcp_tool_call'

/** How the session id was obtained — lets a query tell an exact in-Maskin
 *  session trace apart from a best-effort one. */
export type McpSessionSource =
	/** `X-Maskin-Session-Id` — equals `sessions.id`, joinable to a Maskin session. */
	| 'maskin-session'
	/** `Mcp-Session-Id` supplied by an external client. */
	| 'mcp-session'
	/** Per-process id from the stdio MCP server — one process is one client session. */
	| 'process'
	/** No id available (external HTTP client that sends neither header). */
	| 'unknown'

export interface McpToolCallTrace {
	sessionId: string
	sessionSource: McpSessionSource
	seq: number
	toolName: string
	argKeys: string[]
	ok: boolean
	/** Bucketed misfire kind when `ok` is false. Never the raw error text. */
	errorClass: string | null
	durationMs: number | null
	responseBytes: number | null
	transport: 'http' | 'stdio'
	agentActorId: string | null
}

/**
 * Reduce an arguments object to its sorted key names. Values are dropped
 * entirely — not stringified, not typed, not truncated. Non-object arguments
 * (a bare string, an array, null) yield an empty list rather than leaking
 * their contents.
 */
export function argKeys(args: unknown): string[] {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return []
	return Object.keys(args as Record<string, unknown>).sort()
}

/**
 * Best-effort capture. Never throws and is not awaited by the MCP request
 * path — a PostHog outage must not slow down or fail a tool call.
 */
export async function captureMcpToolCall(
	workspaceId: string,
	trace: McpToolCallTrace,
): Promise<void> {
	const props: PosthogEventProps = {
		workspace_id: workspaceId,
		agent_actor_id: trace.agentActorId,
		session_id: trace.sessionId,
		session_source: trace.sessionSource,
		seq: trace.seq,
		tool_name: trace.toolName,
		arg_keys: trace.argKeys,
		arg_count: trace.argKeys.length,
		ok: trace.ok,
		error_class: trace.errorClass,
		duration_ms: trace.durationMs,
		response_bytes: trace.responseBytes,
		transport: trace.transport,
		// Coarse tiebreak for the multi-replica caveat documented in
		// `lib/mcp-trace-seq.ts`. `seq` remains the authoritative ordering.
		ts_ms: Date.now(),
	}
	// distinct_id: the calling agent when we could resolve it, else the
	// workspace — same fallback the misfire path uses.
	await capturePosthogEvent(MCP_TOOL_CALL_EVENT, trace.agentActorId ?? workspaceId, props)
}
