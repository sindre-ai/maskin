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
	// Rolling-kill criterion from the MCP Widget UX bet: widget render failures
	// above 10% in any 48h window pause shipping and revert to the Markdown
	// deep-link fallback in `content[0].text`. The window is fixed at 48h
	// independent of `?days=` — the kill switch only cares about the most
	// recent two days. `render_error_kill_switch_breach=true` is the signal
	// dashboards and Slack monitors should escalate on.
	widget_renders_48h: z.number().int().min(0),
	widget_render_errors_48h: z.number().int().min(0),
	render_error_pct_48h: z.number().min(0).max(100),
	render_error_kill_switch_pct: z.number().min(0).max(100),
	render_error_kill_switch_breach: z.boolean(),
})

export type McpTelemetrySummary = z.infer<typeof mcpTelemetrySummarySchema>
