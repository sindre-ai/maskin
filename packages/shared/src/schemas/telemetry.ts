import { z } from 'zod'

// Events emitted by the MCP server to /api/telemetry/mcp.
//
// Three event types power the MCP bet metrics:
//   - tool_call:    every tool response. `has_rich_render` is true when the tool
//                   returned `_meta.ui` (i.e. a widget resource was attached so a
//                   client like Claude can render a rich card). Numerator/denominator
//                   of the "50% of MCP tool calls render a rich card" metric.
//   - mutation:     every successful in-chat mutation (update_objects / delete_object).
//                   Counted per `session_id` to power the "20% of MCP sessions include
//                   at least one in-chat mutation" metric.
//   - widget_event: emitted by a rendered Hero Card widget for click-through,
//                   render success, and render failure. Drives the CTR success
//                   metric on the "Open in Maskin" CTA and the 48h render-error
//                   kill criterion. Click-throughs correlate to their parent render
//                   via shared (session_id, tool_name, object_id).
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

const widgetNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_.-]+$/, 'widget name must be identifier-like')

const cardKindSchema = z.enum(['single', 'list', 'empty'])

const widgetEventKindSchema = z.enum(['click_through', 'render_success', 'render_error'])

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

export const recordMcpWidgetEventSchema = z.object({
	event_type: z.literal('widget_event'),
	widget_name: widgetNameSchema,
	event: widgetEventKindSchema,
	tool_name: toolNameSchema,
	card_kind: cardKindSchema,
	session_id: sessionIdSchema,
	object_type: z.string().min(1).max(64).optional(),
	object_id: z.string().min(1).max(128).optional(),
	// Client-supplied wall-clock ms. Used by aggregation to bound the 48h
	// render-error window when server-side createdAt is too coarse for the
	// rolling check.
	ts: z.number().int().positive().optional(),
})

export const recordMcpTelemetrySchema = z.discriminatedUnion('event_type', [
	recordMcpToolCallSchema,
	recordMcpMutationSchema,
	recordMcpWidgetEventSchema,
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
