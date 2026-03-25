import { z } from 'zod'

export const sessionStatusSchema = z.enum([
	'pending',
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

export const mcpServerConfigSchema = z.object({
	command: z.string(),
	args: z.array(z.string()).default([]),
	env: z.record(z.string()).default({}),
})

export const sessionConfigSchema = z.object({
	base_image: z.string().default('agent-base:latest'),
	runtime: sessionRuntimeSchema.default('claude-code'),
	runtime_config: z.record(z.unknown()).default({}),
	timeout_seconds: z.coerce.number().int().min(30).max(3600).default(600),
	memory_mb: z.coerce.number().int().min(256).max(8192).default(1024),
	cpu_shares: z.coerce.number().int().min(256).max(4096).default(1024),
	mcps: z.array(mcpServerConfigSchema).default([]),
	env_vars: z.record(z.string()).default({}),
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
