import { z } from 'zod'
import { mcpServerSchema } from './sessions'

export const actorTypeSchema = z.enum(['human', 'agent'])

// `capabilities` is a set of opt-in flags that surface per-agent UI on the
// agent detail page. Today the only value that gates anything is 'linkedin',
// which mounts the LinkedIn hero pill, Channels row, and sending block on the
// SDR agent detail without hard-coding the actor name. Kept as a free-form
// string array so future capabilities can land without a schema migration.
export const actorToolsSchema = z.object({
	mcpServers: z.record(z.string(), mcpServerSchema).default({}),
	capabilities: z.array(z.string()).optional(),
})

export const llmConfigSchema = z.object({
	api_key: z.string().optional(),
	model: z.string().optional(),
})

export const ACTOR_DESCRIPTION_MAX_LENGTH = 80

export const createActorSchema = z.object({
	id: z.string().uuid().optional(),
	type: actorTypeSchema,
	name: z.string().min(1),
	email: z.string().email().optional(),
	password: z.string().min(8).optional(),
	description: z.string().max(ACTOR_DESCRIPTION_MAX_LENGTH).optional(),
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
	description: z.string().max(ACTOR_DESCRIPTION_MAX_LENGTH).optional(),
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
//
// Field naming must match the corresponding write-schema keys so that agents doing
// read-modify-write via MCP can pass response fields straight back into update_actor
// without Zod silently stripping camelCase keys.
const jsonbObject = z.record(z.string(), z.unknown()).nullable()

export const agentStateSchema = z.enum(['idle', 'running', 'paused', 'failed'])
export type AgentState = z.infer<typeof agentStateSchema>

export const actorResponseSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	description: z.string().nullable(),
	system_prompt: z.string().nullable(),
	tools: jsonbObject,
	memory: jsonbObject,
	llm_provider: z.string().nullable(),
	llm_config: jsonbObject,
	isSystem: z.boolean(),
	agentState: agentStateSchema.default('idle'),
	agentStateUpdatedAt: z.string().nullable().default(null),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	installedPackageId: z.string().uuid().nullable().optional(),
})

export type ActorResponse = z.infer<typeof actorResponseSchema>

// Compact actor row used by list endpoints (`GET /api/actors`,
// `GET /api/objects/:id/actors`). The optional `role` and `workspaces` fields
// are populated when the row comes from a workspace-members join — agent code
// downstream of the MCP server reads `role`, so renaming or dropping it here
// would silently null out the heroCard owner pill without a compile error.
export const actorListItemSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	description: z.string().nullable(),
	isSystem: z.boolean(),
	agentState: agentStateSchema,
	// Surfaced so MCP list_actors can seed a `(createdAt, id)` next-cursor
	// without a second query, and so the AC-T3 integration test can pull
	// the seek partner off the response.
	createdAt: z.string().nullable().optional(),
	role: z.string().optional(),
	workspaces: z
		.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string() }))
		.optional(),
})

export type ActorListItem = z.infer<typeof actorListItemSchema>
