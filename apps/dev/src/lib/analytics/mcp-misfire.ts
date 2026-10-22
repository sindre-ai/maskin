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
	// The raw JSON-RPC error message. Never stored or sent as-is:
	// `recordMcpMisfire` runs it through `redactErrorMessage` first. Absent for
	// the stdio sink's `error` ingest, which reports no message.
	errorMessage?: string
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

const ERROR_MESSAGE_MAX_CHARS = 500
const PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

interface ZodIssueLike {
	code?: unknown
	path?: unknown
	expected?: unknown
	received?: unknown
	options?: unknown
	keys?: unknown
	type?: unknown
	validation?: unknown
	minimum?: unknown
	maximum?: unknown
}

// Reduce a JSON-RPC error message to a string that says WHY a call failed
// without carrying anything the caller sent. The MCP SDK embeds the Zod issues
// as a JSON array, and some issue text echoes the received value (an invalid
// enum value, for example), so each issue is rebuilt from schema-side fields
// only: path, code, and the expected type or options. `received` is kept just
// for invalid_type, where Zod sets it to a type name, never the value. Same
// policy as `requestedShape`: values (ids, comment text, content) never leave
// the process.
export function redactErrorMessage(raw: string): string {
	const open = raw.indexOf('[')
	const close = raw.lastIndexOf(']')
	if (open !== -1 && close > open) {
		try {
			const issues: unknown = JSON.parse(raw.slice(open, close + 1))
			if (Array.isArray(issues) && issues.length > 0) {
				const described = issues.map((i) => describeIssue((i ?? {}) as ZodIssueLike))
				return capErrorMessage(described.join('; '))
			}
		} catch {
			// Not a Zod issue list: fall through to the text scrub.
		}
	}
	// Free-text fallback (tool-not-found, non-Zod InvalidParams): drop quoted
	// fragments after "received" and anything shaped like an id.
	const scrubbed = raw
		.replace(/received\s+(?:"[^"]*"|'[^']*')/gi, 'received <redacted>')
		.replace(UUID_RE, '<id>')
	return capErrorMessage(scrubbed)
}

function capErrorMessage(s: string): string {
	return s.length > ERROR_MESSAGE_MAX_CHARS ? s.slice(0, ERROR_MESSAGE_MAX_CHARS) : s
}

function describeIssue(i: ZodIssueLike): string {
	const segments = Array.isArray(i.path) ? i.path : []
	// A path segment is normally a field name or array index. Anything else
	// (a z.record key) could be caller data, so it is masked.
	const names = segments.map((s) =>
		typeof s === 'number' || PATH_SEGMENT_RE.test(String(s)) ? String(s) : '<key>',
	)
	const path = names.length > 0 ? names.join('.') : '(root)'
	const code = typeof i.code === 'string' ? i.code : 'unknown'
	let detail = ''
	if (code === 'invalid_type') {
		const received = /^[a-z]+$/.test(String(i.received)) ? String(i.received) : 'unknown'
		detail = `expected ${String(i.expected)}, received ${received}`
	} else if (code === 'invalid_enum_value' && Array.isArray(i.options)) {
		detail = `expected one of ${i.options.join('|')}`
	} else if (code === 'invalid_literal') {
		detail = `expected ${JSON.stringify(i.expected)}`
	} else if (code === 'unrecognized_keys' && Array.isArray(i.keys)) {
		detail = `keys ${i.keys.join(',')}`
	} else if (code === 'too_small' || code === 'too_big') {
		detail = `${String(i.type)} ${String(i.minimum ?? i.maximum)}`
	} else if (code === 'invalid_string') {
		detail = typeof i.validation === 'string' ? i.validation : 'custom'
	}
	return detail ? `${path}: ${code} ${detail}` : `${path}: ${code}`
}

// Best-effort persistence + PostHog fan-out. Neither failure path throws —
// the caller sits on the MCP request path and a telemetry outage must not
// break tool dispatch.
export async function recordMcpMisfire(
	db: Database | undefined,
	workspaceId: string,
	event: McpMisfire,
): Promise<void> {
	const errorMessage =
		event.errorMessage === undefined ? undefined : redactErrorMessage(event.errorMessage)
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
					error_message: errorMessage,
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
		kind: event.kind,
		error_message: errorMessage,
		tool_name: event.toolName,
		session_id: event.sessionId,
		requested_shape: JSON.stringify(event.requestedShape),
	})
}
