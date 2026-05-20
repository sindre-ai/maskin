import { z } from 'zod'

export const sessionStatusSchema = z.enum([
	'pending',
	'queued',
	'starting',
	'running',
	'snapshotting',
	'paused',
	'waiting_for_input',
	'completed',
	'failed',
	'timeout',
])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const sessionRuntimeSchema = z.enum(['claude-code', 'codex', 'custom'])
export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>

/** @deprecated Use mcpServerSchema instead */
export const mcpServerConfigSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).default([]),
	env: z.record(z.string()).default({}),
})

export const mcpServerStdioSchema = z.object({
	type: z.literal('stdio').default('stdio'),
	command: z.string(),
	args: z.array(z.string()).default([]),
	env: z.record(z.string()).default({}),
})

export const mcpServerHttpSchema = z.object({
	type: z.literal('http'),
	url: z.string(),
	headers: z.record(z.string()).default({}),
})

export const mcpServerSchema = z.union([mcpServerStdioSchema, mcpServerHttpSchema])

export const runtimeConfigSchema = z.object({
	max_turns: z.number().int().positive().optional(),
	approval_mode: z.string().optional(),
	command: z.string().optional(),
})

// Set internally by the events route when a comment @mentions an agent.
// Not user-supplied — the events route writes this into sessions.config so the
// UI can find sessions linked to a specific comment thread.
export const sessionMentionContextSchema = z.object({
	object_id: z.string().uuid(),
	comment_event_id: z.number().int().positive(),
	commenter_actor_id: z.string().uuid(),
	notification_id: z.string().uuid().optional(),
})
export type SessionMentionContext = z.infer<typeof sessionMentionContextSchema>

// Set internally by the events route when a new comment lands in a thread an
// agent previously participated in (commented or was @mentioned), without the
// agent being explicitly @mentioned in the new comment. Lets the UI attach a
// live activity card under the triggering comment, same as mention sessions.
export const sessionThreadReplyContextSchema = z.object({
	object_id: z.string().uuid(),
	comment_event_id: z.number().int().positive(),
	thread_root_event_id: z.number().int().positive(),
	commenter_actor_id: z.string().uuid(),
})
export type SessionThreadReplyContext = z.infer<typeof sessionThreadReplyContextSchema>

export const sessionConfigSchema = z.object({
	base_image: z.string().default('agent-base:latest'),
	runtime: sessionRuntimeSchema.default('claude-code'),
	runtime_config: runtimeConfigSchema.default({}),
	timeout_seconds: z.coerce.number().int().min(30).max(3600).default(600),
	memory_mb: z.coerce.number().int().min(256).max(8192).default(4096),
	cpu_shares: z.coerce.number().int().min(256).max(4096).default(1024),
	mcps: z.array(mcpServerSchema).default([]),
	env_vars: z.record(z.string()).default({}),
	interactive: z.boolean().default(false),
	mention: sessionMentionContextSchema.optional(),
	thread_reply: sessionThreadReplyContextSchema.optional(),
})

export const createSessionSchema = z.object({
	actor_id: z.string().uuid(),
	action_prompt: z.string().min(1),
	config: sessionConfigSchema.partial().default({}),
	trigger_id: z.string().uuid().optional(),
	auto_start: z.boolean().default(true),
})

export const sessionQuerySchema = z.object({
	status: sessionStatusSchema.optional(),
	actor_id: z.string().uuid().optional(),
	mention_object_id: z.string().uuid().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	offset: z.coerce.number().int().min(0).default(0),
})

export const sessionLogQuerySchema = z.object({
	since: z.coerce.number().int().optional(),
	stream: z.enum(['stdout', 'stderr', 'system']).optional(),
	limit: z.coerce.number().int().min(1).max(500).default(100),
})

export const sessionParamsSchema = z.object({
	id: z.string().uuid(),
})

export const sessionInputAttachmentSchema = z.object({
	kind: z.string().min(1),
	id: z.string().min(1),
})

export const sessionInputSchema = z.object({
	content: z.string().min(1),
	attachments: z.array(sessionInputAttachmentSchema).optional(),
})

export const sessionUsageBucketSchema = z.enum(['hour', 'day', 'week'])
export type SessionUsageBucket = z.infer<typeof sessionUsageBucketSchema>

export const sessionUsageQuerySchema = z.object({
	actor_id: z.string().uuid(),
	from: z.string().datetime(),
	to: z.string().datetime(),
	bucket: sessionUsageBucketSchema,
})

export const sessionUsageBucketResponseSchema = z.object({
	bucket: z.string(),
	session_count: z.number().int().min(0),
	total_cost_usd: z.number(),
	input_tokens: z.number().int().min(0),
	output_tokens: z.number().int().min(0),
	// Combined cache_creation_input_tokens + cache_read_input_tokens.
	// Surfaced as a single series on the chart; the underlying DB
	// columns remain split for future per-component reporting.
	cache_tokens: z.number().int().min(0),
})

export const sessionUsageTotalsSchema = z.object({
	session_count: z.number().int().min(0),
	total_cost_usd: z.number(),
	input_tokens: z.number().int().min(0),
	output_tokens: z.number().int().min(0),
	cache_tokens: z.number().int().min(0),
})

export const sessionUsageResponseSchema = z.object({
	buckets: z.array(sessionUsageBucketResponseSchema),
	totals: sessionUsageTotalsSchema,
})
export type SessionUsageResponse = z.infer<typeof sessionUsageResponseSchema>
