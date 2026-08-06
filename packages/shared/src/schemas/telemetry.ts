import { z } from 'zod'

// Events emitted by the MCP server to /api/telemetry/mcp.
//
// Four event types power the bet's success metrics:
//   - tool_call:    every tool response. `has_rich_render` is true when the tool
//                   returned `_meta.ui` (i.e. a widget resource was attached so a
//                   client like Claude can render a rich card). Numerator/denominator
//                   of the "50% of MCP tool calls render a rich card" metric.
//   - mutation:     every successful in-chat mutation (update_objects / delete_object).
//                   Counted per `session_id` to power the "20% of MCP sessions include
//                   at least one in-chat mutation" metric.
//   - widget_event: every Hero Card mount/click/error reported by `recordWidgetEvent`
//                   in `packages/mcp/src/telemetry.ts`. Powers the bet's CTR ≥30%
//                   success metric and the 48h rolling render-error kill criterion.
//                   click_through rows correlate back to their parent render_success
//                   by shared (session_id, tool_name, object_id).
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

const widgetNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'widget name must be identifier-like')

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

// Widget telemetry emitted by Hero Card and any future MCP widget bundle.
// Mirrors the `WidgetEvent` shape in `packages/mcp/src/telemetry.ts` — keep
// the two in sync. The producer is the MCP server's `recordWidgetEvent`
// helper, called from the `record_widget_event` tool handler that the widget
// invokes from the browser. `session_id` is required (not optional) because
// the CTR aggregation needs a correlator to link click_through rows back to
// their render_success peer.
export const recordMcpWidgetEventSchema = z.object({
	event_type: z.literal('widget_event'),
	widget_name: widgetNameSchema,
	event: z.enum(['render_success', 'render_error', 'click_through']),
	tool_name: toolNameSchema,
	session_id: z.string().min(1).max(128),
	card_kind: z.enum(['single', 'list', 'empty']),
	object_type: z.string().min(1).max(64).optional(),
	object_id: z.string().min(1).max(128).optional(),
	ts: z.number().int().min(0),
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
	recordMcpWidgetEventSchema,
	recordMcpToolCallResponseSizeSchema,
	recordMcpErrorSchema,
])

export type RecordMcpTelemetryBody = z.infer<typeof recordMcpTelemetrySchema>

export const mcpTelemetrySummaryQuerySchema = z.object({
	since: z.string().datetime({ offset: true }).optional(),
	days: z.coerce.number().int().min(1).max(90).optional(),
})

// Bet-first measurement window for the MCP widget UX bet's success/kill criteria.
// Computed over render_success + click_through + render_error widget_event rows
// where object_type='bet'. Renders sent by `actor_type='agent'` are excluded so
// honest-host telemetry pollution can't trip the kill switch (consistent with
// the visibility gate that hides record_widget_event from agents in compliant
// hosts). All percentages are 0–100 (not 0–1).
export const widgetBetFirstWindowSchema = z.object({
	bet_renders_total: z.number().int().min(0),
	bet_render_errors_total: z.number().int().min(0),
	bet_click_throughs_total: z.number().int().min(0),
	// First-200 rolling CTR — the bet's success metric. `pct` is null until the
	// window opens (zero renders).
	ctr_first_200: z.object({
		renders: z.number().int().min(0),
		clicks: z.number().int().min(0),
		pct: z.number().min(0).max(100).nullable(),
		target_pct: z.number().min(0).max(100),
		target_met: z.boolean(),
	}),
	// First-50 rolling CTR — the kill window. `kill_triggered` is true once we
	// have ≥50 renders and the CTR is below the threshold.
	ctr_first_50_kill: z.object({
		renders: z.number().int().min(0),
		clicks: z.number().int().min(0),
		pct: z.number().min(0).max(100).nullable(),
		kill_threshold_pct: z.number().min(0).max(100),
		kill_triggered: z.boolean(),
	}),
	// 48h rolling render-error rate. `kill_triggered` is true once the window
	// has ≥1 render attempt and the error rate exceeds the threshold.
	render_error_48h: z.object({
		renders: z.number().int().min(0),
		errors: z.number().int().min(0),
		pct: z.number().min(0).max(100).nullable(),
		kill_threshold_pct: z.number().min(0).max(100),
		kill_triggered: z.boolean(),
	}),
})

export type WidgetBetFirstWindow = z.infer<typeof widgetBetFirstWindowSchema>

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
	widget_bet_first_window: widgetBetFirstWindowSchema,
})

export type McpTelemetrySummary = z.infer<typeof mcpTelemetrySummarySchema>
