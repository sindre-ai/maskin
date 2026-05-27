import { z } from 'zod'

// Events emitted by the MCP server to /api/telemetry/mcp.
//
// Two event types power the bet's success metrics:
//   - tool_call: every tool response. `has_rich_render` is true when the tool
//                returned `_meta.ui` (i.e. a widget resource was attached so a
//                client like Claude can render a rich card). Numerator/denominator
//                of the "50% of MCP tool calls render a rich card" metric.
//   - mutation:  every successful in-chat mutation (update_objects / delete_object).
//                Counted per `session_id` to power the "20% of MCP sessions include
//                at least one in-chat mutation" metric.
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

// Hard ceiling on size fields — protects the DB from a malformed sender claiming
// a 10GB response. 10 MiB is well past any sane MCP tool response (the biggest
// list_objects payload today is <100KB) but small enough to fit in a 4-byte int.
const RESPONSE_SIZE_MAX = 10 * 1024 * 1024

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
	// Optional response-size fields powering the bet's tokens-per-tool-result
	// metric. The MCP wrapper sets all three together when it can measure the
	// response; older clients (or tool throws) omit them.
	content_bytes: z.number().int().min(0).max(RESPONSE_SIZE_MAX).optional(),
	content_tokens: z.number().int().min(0).max(RESPONSE_SIZE_MAX).optional(),
	structured_content_bytes: z.number().int().min(0).max(RESPONSE_SIZE_MAX).optional(),
})

export const recordMcpMutationSchema = z.object({
	event_type: z.literal('mutation'),
	tool_name: toolNameSchema,
	session_id: sessionIdSchema,
	object_type: z.string().min(1).max(64).optional(),
	mutation_kind: z.string().min(1).max(64),
})

export const recordMcpTelemetrySchema = z.discriminatedUnion('event_type', [
	recordMcpToolCallSchema,
	recordMcpMutationSchema,
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
	// Lean-MCP-results bet — primary metric: % of MCP sessions with ≥1 deep-link
	// click (target ≥30%). Secondary: average tokens per tool_call response
	// (target ≥60% reduction vs. baseline). Null on the averages means no
	// `tool_call` rows had a size measurement in the window (no calls yet, or
	// older clients that don't emit the size fields).
	clicks_total: z.number().int().min(0),
	sessions_with_click: z.number().int().min(0),
	click_session_pct: z.number().min(0).max(100),
	click_session_target_pct: z.number().min(0).max(100),
	click_session_target_met: z.boolean(),
	avg_content_bytes: z.number().min(0).nullable(),
	avg_content_tokens: z.number().min(0).nullable(),
	avg_structured_content_bytes: z.number().min(0).nullable(),
	tool_call_size_samples: z.number().int().min(0),
})

export type McpTelemetrySummary = z.infer<typeof mcpTelemetrySummarySchema>
