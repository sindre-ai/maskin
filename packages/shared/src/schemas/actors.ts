import { z } from 'zod'
import { type FirstStep, firstStepSchema } from './first-steps'
import { mcpServerSchema } from './sessions'

export const actorTypeSchema = z.enum(['human', 'agent'])

export const actorToolsSchema = z.object({
	mcpServers: z.record(z.string(), mcpServerSchema).default({}),
	/**
	 * Names of workspace-level secrets (AGENT_SECRET_* process env on the API
	 * service) to copy into this actor's session env, so tool headers can
	 * reference them as ${AGENT_SECRET_X} instead of holding the token in plain
	 * text. Names only, never values. Names without the AGENT_SECRET_ prefix are
	 * ignored at launch (see resolveActorSecretEnv in apps/dev session-manager).
	 */
	envFrom: z.array(z.string()).optional(),
})

export const llmConfigSchema = z.object({
	api_key: z.string().optional(),
	model: z.string().optional(),
})

/**
 * An agent's tagline — the one line under its name on the agent screens. This
 * is a UI cap, enforced by the agent editor's `maxLength`, not a storage bound.
 */
export const ACTOR_DESCRIPTION_MAX_LENGTH = 80

/**
 * Storage bound for `actors.description`. Humans write prose into this same
 * column via Profile's "How to work with me" — multi-paragraph text their
 * agents receive on the actor record — so the schema has to admit prose while
 * the agent tagline keeps its own 80-character UI cap above. The column is
 * `text`, so this is purely an input bound; nothing here needs a migration.
 */
export const ACTOR_DESCRIPTION_MAX_STORED_LENGTH = 2000

export { type FirstStep, firstStepSchema }

export const createActorSchema = z.object({
	id: z.string().uuid().optional(),
	type: actorTypeSchema,
	name: z.string().min(1),
	email: z.string().email().optional(),
	password: z.string().min(8).optional(),
	description: z.string().max(ACTOR_DESCRIPTION_MAX_STORED_LENGTH).optional(),
	system_prompt: z.string().optional(),
	tools: actorToolsSchema.optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
	auto_create_workspace: z.boolean().optional(),
	// Agents only: the workspace the new agent is born into. The caller must be a
	// member of it. Never accepted for humans (signup mints its own workspace).
	workspace_id: z.string().uuid().optional(),
	// Agents only (ignored for humans). Hints for the new agent's intro message;
	// nothing here is stored on the actor. Shape errors are 400s. Content problems
	// never fail creation: a provider name that is unknown, or has no tools an
	// agent could use, is dropped by the intro and counted.
	first_steps: z.array(firstStepSchema).min(1).max(4).optional(),
	needed_integrations: z.array(z.string().min(1).max(100)).min(1).max(4).optional(),
})

export const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1),
})

export const updateActorSchema = z.object({
	name: z.string().min(1).optional(),
	email: z.string().email().optional(),
	description: z.string().max(ACTOR_DESCRIPTION_MAX_STORED_LENGTH).optional(),
	system_prompt: z.string().optional(),
	tools: actorToolsSchema.optional(),
	memory: z.record(z.unknown()).optional(),
	llm_provider: z.string().optional(),
	llm_config: llmConfigSchema.optional(),
	// The caller's own default workspace; null clears it. Only accepted when the
	// target actor is the caller, and only for a workspace the caller belongs to.
	default_workspace_id: z.string().uuid().nullable().optional(),
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
	installedLoopId: z.string().uuid().nullable().optional(),
	// Projected from actors.metadata->>'voice_enabled'. Read-only on this
	// endpoint (write is POST /actors/:id/voice-mode); mirrors the same
	// projection pattern that already exposes installedLoopId. Optional at
	// the type level so existing fixtures and callers that pre-date the
	// voice bet don't have to synthesise a value — the discovery surfaces
	// treat `undefined` as "voice off" via a strict `=== true` check.
	voice_enabled: z.boolean().optional(),
	// Where the actor's uploaded picture is served (POST /actors/:id/avatar), null until one is set.
	avatar_url: z.string().nullable().optional(),
	default_workspace_id: z.string().uuid().nullable().optional(),
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
	// Projected from actors.metadata->>'voice_enabled' — same pattern
	// actorResponseSchema uses. Optional so existing fixtures don't need to
	// synthesise a value; the discovery surfaces treat `undefined` as "voice
	// off" via a strict `=== true` check.
	voice_enabled: z.boolean().optional(),
	// Where the actor's uploaded picture is served (POST /actors/:id/avatar), null until one is set.
	avatar_url: z.string().nullable().optional(),
	workspaces: z
		.array(z.object({ id: z.string().uuid(), name: z.string(), role: z.string() }))
		.optional(),
	// Skill names only (valid skills of the requested workspace, sorted). Present
	// only under `include=skills` on a workspace-scoped list, and only on agents
	// that have at least one.
	skills: z.array(z.string()).optional(),
})

export type ActorListItem = z.infer<typeof actorListItemSchema>
