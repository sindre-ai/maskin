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
//   - tool_call_response_size: how big a tool response was, and why. Byte +
//                   token splits of `content` vs `structuredContent` give the
//                   p95-per-tool baseline; the shape fields (`row_count`,
//                   `max_row_bytes`, `top_fields`) say whether a heavy response
//                   is heavy from row count or row width, and which fields to
//                   trim. `seq` + `arg_keys` join it to the `tool_call` event
//                   for the same call. Fan-out to PostHog as
//                   `mcp_tool_call_response_size`.
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

// Replace an invalid value with `fallback` instead of failing the parse — the
// behaviour of `schema.catch(fallback)`, built from `z.preprocess` because
// `ZodCatch` has no OpenAPI mapping: a single `.catch()` anywhere in a
// documented route makes `getOpenAPI31Document()` throw, which takes down
// `/api/openapi.json` and every SDK generated from it (the Apple client's
// `apps/apple/openapi.json` snapshot included). `ZodEffects` is read through
// to its inner schema, so the documented shape is the strict one.
function degradeTo<T extends z.ZodTypeAny>(schema: T, fallback: z.infer<T>) {
	return z.preprocess((value) => (schema.safeParse(value).success ? value : fallback), schema)
}

// Argument KEY NAMES only — never values. Constrained to identifier-like
// strings and a bounded count so a misbehaving or hostile client can't smuggle
// free text (which is exactly what this field exists to keep out) through the
// boundary by passing an object whose keys are sentences.
const argKeysSchema = degradeTo(
	z
		.array(
			z
				.string()
				.min(1)
				.max(64)
				.regex(/^[A-Za-z0-9_.-]+$/, 'arg key must be identifier-like'),
		)
		.max(64)
		.optional(),
	// Degrade, don't reject. `arg_keys` is optional analytics riding along on an
	// event whose primary job is the pre-existing `mcp_telemetry` row (tool
	// name, rich-render flag, duration). Failing the whole body would 400 the
	// request before the handler runs and silently discard that row — and the
	// client sink logs one line per process lifetime, so the loss would be
	// invisible. A tool declaring a param the regex rejects (custom extensions
	// define their own schemas) must cost us the key list, not the event.
	[],
)

// Response field names, ranked by bytes. Same constraints as `arg_keys` and
// the same degrade-don't-reject behaviour: a rejected name must cost the name,
// not the size event it rides on.
const MAX_TOP_FIELDS = 8

const fieldNamesSchema = degradeTo(
	z
		.array(
			z
				.string()
				.min(1)
				.max(64)
				.regex(/^[A-Za-z0-9_.-]+$/, 'field name must be identifier-like'),
		)
		.max(MAX_TOP_FIELDS)
		.optional(),
	[],
)

// Protocol-era labels for the 2026-07-28 / SDK v2 migration bet. Fixed label
// sets, never a raw header value: the producer (`classifyMcpEra` in apps/dev)
// maps whatever the client declared onto one of these. The version list is
// static here because this package cannot import the MCP SDK; a test in
// apps/dev fails if it ever drifts from the SDK's supported-versions constant.
export const MCP_ERAS = ['legacy', 'modern'] as const
export const MCP_PROTOCOL_VERSION_LABELS = [
	'2025-11-25',
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
	'2024-10-07',
	'2026-07-28',
	'other',
	'none',
] as const

export type McpEra = (typeof MCP_ERAS)[number]
export type McpProtocolVersionLabel = (typeof MCP_PROTOCOL_VERSION_LABELS)[number]

// Optional AND degrade-don't-reject, like `arg_keys`: an unexpected value must
// cost the label, never the whole row. An older MCP build sends neither field.
const mcpEraSchema = degradeTo(z.enum(MCP_ERAS).optional(), undefined)
const mcpProtocolVersionSchema = degradeTo(
	z.enum(MCP_PROTOCOL_VERSION_LABELS).optional(),
	undefined,
)

// Which object type a list-family call listed, for the list-tools bet's
// retry-pair measure ("two list calls on the same object type within 5 calls").
// A fixed vocabulary, never a raw argument: `type` can be a workspace-defined
// custom type, and a custom type name is workspace-authored text that must not
// reach analytics. Anything outside the built-in set is the literal `other`.
export const LIST_CALL_BUILT_IN_OBJECT_TYPES = [
	'bet',
	'task',
	'insight',
	'knowledge',
	'company',
	'contact',
	'content',
	'event',
	'meeting',
	'loop',
] as const

// The four list tools whose type is fixed by the tool itself.
const FIXED_LIST_TOOL_TYPES = {
	list_triggers: 'trigger',
	list_loops: 'loop',
	list_workspace_skills: 'skill',
	list_extensions: 'extension',
} as const

export const LIST_CALL_OBJECT_TYPES = [
	...LIST_CALL_BUILT_IN_OBJECT_TYPES,
	'trigger',
	'skill',
	'extension',
	'other',
	'none',
] as const

export type ListCallObjectType = (typeof LIST_CALL_OBJECT_TYPES)[number]

const BUILT_IN_OBJECT_TYPE_SET: ReadonlySet<string> = new Set(LIST_CALL_BUILT_IN_OBJECT_TYPES)

/**
 * Object type for the six list-family tools; undefined for every other tool.
 * `list_objects` and `search_objects` read the `type` argument: a built-in type
 * passes through, no `type` is `none`, anything else (custom type, free text,
 * non-string) is `other`. The other four tools return their own fixed type.
 */
export function listCallObjectType(
	toolName: string,
	args: unknown,
): ListCallObjectType | undefined {
	if (toolName in FIXED_LIST_TOOL_TYPES) {
		return FIXED_LIST_TOOL_TYPES[toolName as keyof typeof FIXED_LIST_TOOL_TYPES]
	}
	if (toolName !== 'list_objects' && toolName !== 'search_objects') return undefined
	const type =
		args && typeof args === 'object' && !Array.isArray(args)
			? (args as Record<string, unknown>).type
			: undefined
	if (type === undefined || type === null || type === '') return 'none'
	if (typeof type === 'string' && BUILT_IN_OBJECT_TYPE_SET.has(type)) {
		return type as ListCallObjectType
	}
	return 'other'
}

// Optional and degrade-don't-reject, like `arg_keys`: an unexpected value costs
// the label, never the whole row. An older MCP build sends none.
const listCallObjectTypeSchema = degradeTo(z.enum(LIST_CALL_OBJECT_TYPES).optional(), undefined)

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
	object_type: listCallObjectTypeSchema,
	ok: z.boolean().optional(),
	transport: z.enum(['stdio', 'http']).optional(),
	// How the client resolved `session_id`. Only the client knows this: a
	// container-launched stdio server holds a real `sessions.id`, a standalone
	// one holds a per-process correlation id, and the two are indistinguishable
	// from the id alone. Absent from an older build, which the route treats as
	// the conservative `process`.
	//
	// `unknown` means the id groups nothing: it is a per-request throwaway
	// minted because the caller supplied no identity at all. It is load-bearing
	// rather than cosmetic — the ingest route stores NO `session_id` for these
	// rows, keeping them out of the per-session metric they would otherwise
	// distort. See the `sessionId` comment in `routes/telemetry.ts`.
	session_source: z.enum(['maskin-session', 'process', 'unknown']).optional(),
	mcp_era: mcpEraSchema,
	mcp_protocol_version: mcpProtocolVersionSchema,
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
	// Shape fields — the "why is it big" half. All optional so an older MCP
	// server build keeps validating. `seq` and `arg_keys` are the join back to
	// the `tool_call` event for the same call: size alone can't distinguish a
	// broad `list_objects` from a narrow one, and that distinction is the whole
	// point of a size investigation.
	seq: z.number().int().min(1).optional(),
	// Which transport the emitting server was exposed over. `http` means the
	// server ran in-process behind `POST /mcp`, where `seq` is deliberately
	// omitted (the paired `tool_call` event is numbered elsewhere) and
	// `session_id` is the per-request identity threaded in by `routes/mcp.ts`
	// rather than the MCP process's own. Optional so an older MCP server build
	// keeps validating.
	transport: z.enum(['stdio', 'http']).optional(),
	arg_keys: argKeysSchema,
	row_count: z.number().int().min(0).optional(),
	max_row_bytes: z.number().int().min(0).optional(),
	content_block_count: z.number().int().min(0).optional(),
	// Field NAMES only, never values — same bar and same regex as `arg_keys`,
	// and it matters more here: these are keys off a *response* row, which can
	// include a workspace-authored `data` jsonb whose keys are free text.
	top_fields: fieldNamesSchema,
	// Positionally aligned with `top_fields`. Bounded to the same length so a
	// client can't ship an unbounded number array through the boundary.
	//
	// The two arrays are validated INDEPENDENTLY, so `.catch([])` can fire on
	// one and not the other and leave them misaligned — 8 names beside 0 byte
	// counts. That is worse than dropping both: a dashboard joining them by
	// position would confidently attribute the wrong size to every named
	// field. `alignTopFields` below re-imposes the invariant at the consumer;
	// it can't be a `.transform` here because this object is a member of a
	// `z.discriminatedUnion`, which (zod 3) accepts only bare ZodObjects.
	top_field_bytes: degradeTo(z.array(z.number().int().min(0)).max(MAX_TOP_FIELDS).optional(), []),
	// True when the producer's shape measurement faulted, making every shape
	// field above a fallback rather than an observation. Without it, a fault is
	// indistinguishable from a correct measurement of a tool that has no row
	// array — both arrive as nulls and empty lists. Optional, and absent on an
	// older MCP server build, which is the same thing as "no fault reported".
	shape_error: z.boolean().optional(),
	mcp_era: mcpEraSchema,
	mcp_protocol_version: mcpProtocolVersionSchema,
	// Which shape of answer the tool gave (list_actors: `slim` default row, `full`
	// when connected triggers/loops were requested). Fixed values only: a bad
	// value costs the property, not the event.
	view: degradeTo(z.enum(['slim', 'full']).optional(), undefined),
})

/**
 * Return `top_fields`/`top_field_bytes` only if they are positionally aligned,
 * and `[]`/`[]` otherwise. Aligned-or-nothing: a ranking with no sizes can't
 * answer "which field do I trim", so half the pair is not worth keeping.
 *
 * Callers must use this rather than reading the two fields directly — see the
 * note on `top_field_bytes`.
 */
export function alignTopFields(
	names: string[] | undefined,
	bytes: number[] | undefined,
): { topFields: string[]; topFieldBytes: number[] } {
	const n = names ?? []
	const b = bytes ?? []
	if (n.length !== b.length) return { topFields: [], topFieldBytes: [] }
	return { topFields: n, topFieldBytes: b }
}

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
	mcp_era: mcpEraSchema,
	mcp_protocol_version: mcpProtocolVersionSchema,
})

// Old-name use for the MCP tool-surface bet: one event per call that reached a
// tool through a deprecated tool name or a deprecated argument key. Its own
// event type, NOT a misfire kind: an alias hit is a success, and the misfire
// count is a headline metric that must not move for this reason. Persisted in
// `mcp_telemetry.data` (jsonb, no schema migration) and fanned out to PostHog
// as `mcp_alias_use`.
//
// Key NAMES only, never values — the same bar as `arg_keys`. `renames` pairs
// the old and new dotted path; array indexes are dropped, so `edges.source_id`,
// never `edges[0].source_id`. `tool_alias` is present only when the tool NAME
// was the old one (run_agent) and absent for key renames. The actor is
// deliberately NOT a field: the ingest route takes it from the authenticated
// request, so a payload cannot claim to be someone else.
export const MAX_ALIAS_RENAMES = 64
export const MAX_ALIAS_DROPPED_KEYS = 16

const keyPathSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_.-]+$/, 'key path must be identifier-like')

export const recordMcpAliasUseSchema = z.object({
	event_type: z.literal('alias_use'),
	// The tool that was called. For a tool-name alias this is the old name.
	tool_name: toolNameSchema,
	session_id: sessionIdSchema,
	session_source: z.enum(['maskin-session', 'process', 'unknown']).optional(),
	transport: z.enum(['stdio', 'http']).optional(),
	renames: z
		.array(z.object({ old: keyPathSchema, new: keyPathSchema }))
		.max(MAX_ALIAS_RENAMES)
		.default([]),
	// Both the old and the new spelling were sent. The new one wins; no value
	// comparison is made or logged.
	both_sent: z.boolean().default(false),
	// Key names removed with no replacement (the run_agent alias only).
	dropped_keys: z.array(keyPathSchema).max(MAX_ALIAS_DROPPED_KEYS).optional(),
	tool_alias: z.object({ old: toolNameSchema, new: toolNameSchema }).optional(),
})

export type RecordMcpAliasUseBody = z.infer<typeof recordMcpAliasUseSchema>

export const recordMcpTelemetrySchema = z.discriminatedUnion('event_type', [
	recordMcpToolCallSchema,
	recordMcpMutationSchema,
	recordMcpToolCallResponseSizeSchema,
	recordMcpErrorSchema,
	recordMcpAliasUseSchema,
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
