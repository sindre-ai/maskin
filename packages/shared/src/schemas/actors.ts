import { z } from 'zod'

export const actorTypeSchema = z.enum(['human', 'agent'])

export const createActorSchema = z.object({
	type: actorTypeSchema,
	name: z.string().min(1),
	email: z.string().email().optional(),
	password: z.string().min(8).optional(),
	system_prompt: z.string().optional(),
	tools: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: z.record(z.unknown()).optional(),
	auto_create_workspace: z.boolean().optional(),
})

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
})

export const updateActorSchema = z.object({
	name: z.string().min(1).optional(),
	email: z.string().email().optional(),
	system_prompt: z.string().optional(),
	tools: z.record(z.unknown()).optional(),
	memory: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: z.record(z.unknown()).optional(),
})

export const actorParamsSchema = z.object({
	id: z.string().uuid(),
})
