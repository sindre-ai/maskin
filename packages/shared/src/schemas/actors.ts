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
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
})

export type ActorResponse = z.infer<typeof actorResponseSchema>

// Compact actor row used by list endpoints (`GET /api/actors`,
// `GET /api/objects/:id/actors`). The endpoint returns two distinct shapes
// depending on whether `X-Workspace-Id` is set:
//   • workspace-scoped: flat `role`, no `workspaces[]` — see actorWorkspaceMemberSchema
//   • cross-workspace : no `role`, a `workspaces[]` array — see actorCrossWorkspaceSchema
// `actorListItemSchema` makes both fields optional so the OpenAPI route handler
// can declare one response shape and so existing extenders (`actorWithRoleSchema`)
// keep working. Consumers that know which call they're making should narrow with
// the strict variants below — reading `actor.role` off a cross-workspace row
// silently returns `undefined` and is what produced this split.
export const actorListItemSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	description: z.string().nullable(),
	isSystem: z.boolean(),
	role: z.string().optional(),
	workspaces: z
		.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string() }))
		.optional(),
})

export type ActorListItem = z.infer<typeof actorListItemSchema>

const actorListItemBaseFields = {
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	description: z.string().nullable(),
	isSystem: z.boolean(),
}

/**
 * Strict shape returned by `GET /api/actors` when `X-Workspace-Id` is supplied:
 * a workspace-members join, with `role` always populated. Use this when calling
 * the workspace-scoped path — `actor.role` is then guaranteed by the type.
 */
export const actorWorkspaceMemberSchema = z.object({
	...actorListItemBaseFields,
	role: z.string(),
})

export type ActorWorkspaceMember = z.infer<typeof actorWorkspaceMemberSchema>

/**
 * Strict shape returned by `GET /api/actors` *without* `X-Workspace-Id`: actors
 * aggregated across every workspace the caller belongs to, with the membership
 * list under `workspaces[]`. There is no flat `role` on this variant.
 */
export const actorCrossWorkspaceSchema = z.object({
	...actorListItemBaseFields,
	workspaces: z.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string() })),
})

export type ActorCrossWorkspace = z.infer<typeof actorCrossWorkspaceSchema>
