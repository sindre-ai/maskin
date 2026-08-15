import type { Database } from '@maskin/db'
import { mcpTelemetry } from '@maskin/db/schema'
import type { McpMisfireKind } from '@maskin/shared'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

// Named PostHog events for the agent-reach-signal bet. Kept parallel to
// `McpMisfireKind` so a new kind requires updating both.
const POSTHOG_EVENT_NAMES: Record<McpMisfireKind, string> = {
	tool_not_found: 'mcp_misfire_tool_not_found',
	unknown_param: 'mcp_misfire_unknown_param',
	schema_validation_error: 'mcp_misfire_schema_validation_error',
}

export interface McpMisfire {
	kind: McpMisfireKind
	toolName: string
	requestedShape: Record<string, string>
	sessionId: string | null
	agentActorId: string | null
}

export interface JsonRpcErrorLike {
	code?: number
	message?: string
}

// Classify a JSON-RPC error into one of the three named misfire kinds. Returns
// null for anything we cannot confidently bucket — we deliberately drop those
// on the floor rather than diluting the three named PostHog events.
//
// The MCP SDK surfaces both "tool not found" and pre-handler schema failures as
// `-32602 InvalidParams`; the message text is the disambiguator.
export function classifyMcpError(error: JsonRpcErrorLike | undefined): McpMisfireKind | null {
	if (!error || typeof error.message !== 'string') return null
	const msg = error.message
	if (/tool\s+.+?\s+(?:not\s+found|not\s+registered|is\s+unknown)/i.test(msg)) {
		return 'tool_not_found'
	}
	if (/unknown\s+tool/i.test(msg)) return 'tool_not_found'
	// -32602 InvalidParams covers both unknown-param and schema-validation
	// failures. Anything else we don't classify.
	if (error.code !== -32602 && !/invalid.*param/i.test(msg)) return null
	if (/unrecognized\s+key|unknown\s+(?:field|argument|property)/i.test(msg)) {
		return 'unknown_param'
	}
	return 'schema_validation_error'
}

// Reduce an args object to a `{fieldName: type}` map. Values are dropped so
// nothing user-visible (object titles, comment content, prompt text) leaks
// into `requested_shape`. Nested objects/arrays collapse to their container
// type — the demand signal we're mining is which *fields* agents reach for,
// not their nesting depth.
export function requestedShape(args: unknown): Record<string, string> {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		out[k] = shapeOf(v)
	}
	return out
}

function shapeOf(v: unknown): string {
	if (v === null) return 'null'
	if (Array.isArray(v)) return 'array'
	return typeof v
}

// Best-effort persistence + PostHog fan-out. Neither failure path throws —
// the caller sits on the MCP request path and a telemetry outage must not
// break tool dispatch.
export async function recordMcpMisfire(
	db: Database | undefined,
	workspaceId: string,
	event: McpMisfire,
): Promise<void> {
	if (db) {
		try {
			await db.insert(mcpTelemetry).values({
				workspaceId,
				eventType: 'error',
				toolName: event.toolName,
				sessionId: event.sessionId ?? null,
				data: {
					kind: event.kind,
					agent_actor_id: event.agentActorId,
					requested_shape: event.requestedShape,
				},
			})
		} catch (err) {
			logger.warn('mcp misfire persist failed', {
				kind: event.kind,
				tool: event.toolName,
				error: String(err),
			})
		}
	}
	const distinctId = event.agentActorId ?? workspaceId
	void capturePosthogEvent(POSTHOG_EVENT_NAMES[event.kind], distinctId, {
		workspace_id: workspaceId,
		agent_actor_id: event.agentActorId,
		tool_name: event.toolName,
		session_id: event.sessionId,
		requested_shape: JSON.stringify(event.requestedShape),
	})
}
