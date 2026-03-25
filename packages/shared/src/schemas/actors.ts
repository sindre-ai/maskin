import { z } from 'zod'
import { mcpServerSchema } from './sessions'

export const actorTypeSchema = z.enum(['human', 'agent'])

export const actorToolsSchema = z.object({
	mcpServers: z.record(z.string(), mcpServerSchema).default({}),
})

export const llmConfigSchema = z.object({
	api_key: z.string().optional(),
	model: z.string().optional(),
})

export const createActorSchema = z.object({
	type: actorTypeSchema,
	name: z.string().min(1),
	email: z.string().email().optional(),
	system_prompt: z.string().optional(),
	tools: actorToolsSchema.optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
	auto_create_workspace: z.boolean().optional(),
})

export const updateActorSchema = z.object({
	name: z.string().min(1).optional(),
	email: z.string().email().optional(),
	system_prompt: z.string().optional(),
	tools: actorToolsSchema.optional(),
	memory: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
})

export const actorParamsSchema = z.object({
	id: z.string().uuid(),
})
