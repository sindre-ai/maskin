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

// Compact actor row used by list endpoints. Two response shapes share this
// schema — pick the one that matches the call site:
//
// - **Workspace-scoped** (`GET /api/actors` with `X-Workspace-Id`, joined to
//   `workspace_members`): `role` is always set, `workspaces` is omitted.
//   Downstream MCP code (e.g. heroCard owner pill) reads `actor.role`.
// - **Cross-workspace** (`GET /api/actors` without `X-Workspace-Id`): `role`
//   is omitted on the top-level row, `workspaces[]` carries the per-workspace
//   memberships with their own `role`. Consumers that read top-level `role`
//   on a cross-workspace response will silently see `undefined`.
//
// Both fields stay optional so a single schema validates both shapes; the
// rename/drop hazard the lift was meant to catch is still covered because
// the field names live in one place.
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
