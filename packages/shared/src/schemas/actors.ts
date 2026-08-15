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

export const agentStateSchema = z.enum(['idle', 'running', 'paused', 'failed'])
export type AgentState = z.infer<typeof agentStateSchema>

export const capabilityLevelSchema = z.enum([
	'novice',
	'apprentice',
	'practitioner',
	'expert',
	'master',
])

export const capabilityDimensionKeySchema = z.enum([
	'expertise',
	'skills',
	'connectors',
	'context',
	'autonomy',
])

export const capabilityDimensionSchema = z.object({
	key: capabilityDimensionKeySchema,
	label: z.string(),
	score: z.number().min(0).max(5),
	weight: z.number().min(0),
	reasons: z.array(z.string()),
})

export const capabilityGapSchema = z.object({
	action: z.string(),
	detail: z.string(),
	dimension: capabilityDimensionKeySchema,
	toolHint: z.string().optional(),
})

export const capabilitySchema = z.object({
	version: z.literal(1),
	overall: z.object({
		score: z.number().min(0).max(100),
		level: capabilityLevelSchema,
	}),
	dimensions: z.array(capabilityDimensionSchema),
	unresolvedPlaceholders: z.array(z.string()),
	topGaps: z.array(capabilityGapSchema),
})

// Grid/list flavour: level + a count is enough to render a chip without
// paying to serialize every dimension for every actor in a workspace.
export const capabilityCompactSchema = z.object({
	level: capabilityLevelSchema,
	score: z.number().min(0).max(100),
	topGapCount: z.number().int().min(0),
})

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
	installedLoopId: z.string().uuid().nullable().optional(),
	// Computed by the API from the actor row + workspace context; `null` for
	// humans, populated for agents. Never accepted on write — updateActorSchema
	// doesn't declare it, so Zod's default strip drops it on PATCH.
	capability: capabilitySchema.nullable().optional(),
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
	// Compact capability for the agent grid — full dimension breakdown lives
	// on GET /:id (actorResponseSchema.capability). `null` for humans.
	capability: capabilityCompactSchema.nullable().optional(),
})

export type ActorListItem = z.infer<typeof actorListItemSchema>
export type Capability = z.infer<typeof capabilitySchema>
export type CapabilityCompact = z.infer<typeof capabilityCompactSchema>
