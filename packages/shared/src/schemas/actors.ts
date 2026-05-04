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
	id: z.string().uuid().optional(),
	type: actorTypeSchema,
	name: z.string().min(1),
	email: z.string().email().optional(),
	password: z.string().min(8).optional(),
	system_prompt: z.string().optional(),
	tools: actorToolsSchema.optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
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
	tools: actorToolsSchema.optional(),
	memory: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
})

export const actorParamsSchema = z.object({
	id: z.string().uuid(),
})

// Server-assigned read-only fields (e.g. isSystem) live on response shapes only.
// Intentionally absent from createActorSchema/updateActorSchema — clients cannot set them.
export const actorResponseSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	systemPrompt: z.string().nullable(),
	tools: z.unknown().nullable(),
	memory: z.unknown().nullable(),
	llmProvider: z.string().nullable(),
	llmConfig: z.unknown().nullable(),
	isSystem: z.boolean(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export type ActorResponse = z.infer<typeof actorResponseSchema>
