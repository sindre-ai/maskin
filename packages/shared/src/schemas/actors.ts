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
export const ACTOR_BIO_MAX_LENGTH = 300

// Notification preferences. The first three default to true (opt-out style — a
// new user is reachable until they silence channels); weeklyDigest defaults to
// false (opt-in for periodic mail). T9 renders one Switch per key.
export const notificationPrefsSchema = z.object({
	mentions: z.boolean().default(true),
	subscribed: z.boolean().default(true),
	betStatusChanges: z.boolean().default(true),
	weeklyDigest: z.boolean().default(false),
})
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>

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

// Note: `email` is intentionally NOT updatable here. Email changes go through
// the verified flow in POST /auth/email-change so a stolen API key can't
// silently swap the address.
export const updateActorSchema = z.object({
	name: z.string().min(1).optional(),
	description: z.string().max(ACTOR_DESCRIPTION_MAX_LENGTH).optional(),
	bio: z.string().max(ACTOR_BIO_MAX_LENGTH).nullable().optional(),
	notification_prefs: notificationPrefsSchema.partial().optional(),
	system_prompt: z.string().optional(),
	tools: actorToolsSchema.optional(),
	memory: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
})

export const actorParamsSchema = z.object({
	id: z.string().uuid(),
})

export const changePasswordSchema = z.object({
	current_password: z.string().min(1),
	new_password: z.string().min(8),
})

export const requestEmailChangeSchema = z.object({
	new_email: z.string().email(),
	current_password: z.string().min(1),
})

export const verifyEmailChangeSchema = z.object({
	token: z.string().min(1),
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
	bio: z.string().nullable(),
	avatar_storage_key: z.string().nullable(),
	notification_prefs: notificationPrefsSchema.nullable(),
	pending_email: z.string().nullable(),
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
	role: z.string().optional(),
	workspaces: z
		.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string() }))
		.optional(),
})

export type ActorListItem = z.infer<typeof actorListItemSchema>
