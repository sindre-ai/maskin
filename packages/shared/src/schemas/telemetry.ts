import { z } from 'zod'

// Events emitted by the MCP server to /api/telemetry/mcp.
//
// Three event types power the bet's success metrics:
//   - tool_call:    every tool response. `has_rich_render` is true when the tool
//                   returned `_meta.ui` (i.e. a widget resource was attached so a
//                   client like Claude can render a rich card). Numerator/denominator
//                   of the "50% of MCP tool calls render a rich card" metric.
//   - mutation:     every successful in-chat mutation (update_objects / delete_object).
//                   Counted per `session_id` to power the "20% of MCP sessions include
//                   at least one in-chat mutation" metric.
//   - tool_call_response_size: byte + token splits of `content` vs `structuredContent`
//                   on every tool response. Fan-out to PostHog as
//                   `mcp_tool_call_response_size` for the response-scoping bet's
//                   p95-per-tool baseline.
//
// Tool name is constrained loosely (1–128 chars, identifier-ish characters).
// The MCP server is the producer, but we still validate at the boundary because
// custom-extension tool names flow through the same code path.
const toolNameSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_.-]+$/, 'tool name must be identifier-like')

const sessionIdSchema = z.string().min(1).max(128).optional()

// Argument KEY NAMES only — never values. Constrained to identifier-like
// strings and a bounded count so a misbehaving or hostile client can't smuggle
// free text (which is exactly what this field exists to keep out) through the
// boundary by passing an object whose keys are sentences.
const argKeysSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_.-]+$/, 'arg key must be identifier-like'),
	)
	.max(64)
	.optional()
	// Degrade, don't reject. `arg_keys` is optional analytics riding along on an
	// event whose primary job is the pre-existing `mcp_telemetry` row (tool
	// name, rich-render flag, duration). Failing the whole body would 400 the
	// request before the handler runs and silently discard that row — and the
	// client sink logs one line per process lifetime, so the loss would be
	// invisible. A tool declaring a param the regex rejects (custom extensions
	// define their own schemas) must cost us the key list, not the event.
	.catch([])

export const recordMcpToolCallSchema = z.object({
	event_type: z.literal('tool_call'),
	tool_name: toolNameSchema,
	session_id: sessionIdSchema,
	has_rich_render: z.boolean(),
	duration_ms: z
		.number()
		.int()
		.min(0)
		.max(60 * 60 * 1000),
	// Trace fields. Optional so an older MCP server build keeps validating.
	// `seq` orders calls within a session; wall-clock can't, because these
	// events are fire-and-forget and can be ingested out of order.
	seq: z.number().int().min(1).optional(),
	arg_keys: argKeysSchema,
	ok: z.boolean().optional(),
	transport: z.enum(['stdio', 'http']).optional(),
	// How the client resolved `session_id`. Only the client knows this: a
	// container-launched stdio server holds a real `sessions.id`, a standalone
	// one holds a per-process correlation id, and the two are indistinguishable
	// from the id alone. Absent from an older build, which the route treats as
	// the conservative `process`.
	session_source: z.enum(['maskin-session', 'process']).optional(),
})

export const recordMcpMutationSchema = z.object({
	event_type: z.literal('mutation'),
	tool_name: toolNameSchema,
	session_id: sessionIdSchema,
	object_type: z.string().min(1).max(64).optional(),
	mutation_kind: z.string().min(1).max(64),
})

// Response size telemetry for the MCP response-scoping bet's First test. Fan-out
// is PostHog only (event name `mcp_tool_call_response_size`) — no DB row, since
// the 5-day instrumentation window doesn't earn a schema migration. `truncated`
// is hard-coded `false` here and flips `true` once T4's token-cap wrapper lands.
// Byte counts use `Buffer.byteLength(_, 'utf8')` and token counts are a
// `bytes/4` estimator (good enough to rank tools by p95).
export const recordMcpToolCallResponseSizeSchema = z.object({
	event_type: z.literal('tool_call_response_size'),
	tool_name: toolNameSchema,
	session_id: sessionIdSchema,
	content_bytes: z.number().int().min(0),
	content_tokens: z.number().int().min(0),
	structured_content_bytes: z.number().int().min(0),
	structured_content_tokens: z.number().int().min(0),
	truncated: z.boolean(),
})

// MCP misfire events for the agent-reach-signal bet: one row per real MCP
// runtime error we can bucket into a demand signal. Persisted in
// `mcp_telemetry.data` (jsonb, no schema migration) and fanned out to PostHog
// as `mcp_misfire_tool_not_found` / `mcp_misfire_unknown_param` /
// `mcp_misfire_schema_validation_error`. `requested_shape` is a
// `{fieldName: type}` map — values are stripped so no user-visible PII lands
// in analytics. `agent_actor_id` is the API key's actor id, resolved by the
// producer (server-side classifier or client sink).
export const mcpMisfireKindSchema = z.enum([
	'tool_not_found',
	'unknown_param',
	'schema_validation_error',
])
export type McpMisfireKind = z.infer<typeof mcpMisfireKindSchema>

export const recordMcpErrorSchema = z.object({
	event_type: z.literal('error'),
	kind: mcpMisfireKindSchema,
	tool_name: toolNameSchema,
	session_id: sessionIdSchema,
	agent_actor_id: z.string().min(1).max(128).optional(),
	requested_shape: z.record(z.string(), z.string()).default({}),
})

export const recordMcpTelemetrySchema = z.discriminatedUnion('event_type', [
	recordMcpToolCallSchema,
	recordMcpMutationSchema,
	recordMcpToolCallResponseSizeSchema,
	recordMcpErrorSchema,
])

export type RecordMcpTelemetryBody = z.infer<typeof recordMcpTelemetrySchema>

export const mcpTelemetrySummaryQuerySchema = z.object({
	since: z.string().datetime({ offset: true }).optional(),
	days: z.coerce.number().int().min(1).max(90).optional(),
})

export const mcpTelemetrySummarySchema = z.object({
	workspace_id: z.string().uuid(),
	window_start: z.string().datetime({ offset: true }),
	window_end: z.string().datetime({ offset: true }),
	tool_calls_total: z.number().int().min(0),
	tool_calls_rich: z.number().int().min(0),
	rich_render_pct: z.number().min(0).max(100),
	rich_render_target_pct: z.number().min(0).max(100),
	rich_render_target_met: z.boolean(),
	sessions_total: z.number().int().min(0),
	sessions_with_mutation: z.number().int().min(0),
	mutation_session_pct: z.number().min(0).max(100),
	mutation_session_target_pct: z.number().min(0).max(100),
	mutation_session_target_met: z.boolean(),
	mutations_total: z.number().int().min(0),
	rich_render_by_day: z.array(
		z.object({
			day: z.string(),
			tool_calls: z.number().int().min(0),
			rich_calls: z.number().int().min(0),
			rich_pct: z.number().min(0).max(100),
		}),
	),
})

export type McpTelemetrySummary = z.infer<typeof mcpTelemetrySummarySchema>
