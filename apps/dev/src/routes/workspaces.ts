import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, triggers, workspaceMembers, workspaces } from '@maskin/db/schema'
import { getModule } from '@maskin/module-sdk'
import {
	SINDRE_DEFAULT,
	createWorkspaceSchema,
	updateWorkspaceSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema, idParamSchema, workspaceResponseSchema } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const memberResponseSchema = z.object({
	actorId: z.string().uuid(),
	role: z.string(),
	joinedAt: z.string().nullable(),
	name: z.string(),
	type: z.string(),
})

const addMemberBodySchema = z.object({
	actor_id: z.string().uuid(),
	role: z.string().optional(),
})

const workspaceWithRoleSchema = workspaceResponseSchema.extend({
	role: z.string(),
})

const app = new OpenAPIHono<Env>()

// POST /api/workspaces
const createWorkspaceRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['workspaces'],
	summary: 'Create workspace',
	request: {
		body: {
			content: {
				'application/json': {
					schema: createWorkspaceSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Workspace created',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createWorkspaceRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const settings = workspaceSettingsSchema.parse(body.settings ?? {})

	const workspace = await db.transaction(async (tx) => {
		const [ws] = await tx
			.insert(workspaces)
			.values({
				name: body.name,
				settings,
				createdBy: actorId,
			})
			.returning()

		if (!ws) return null

		// Auto-add creator as owner
		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId,
			role: 'owner',
		})

		// Seed Sindre — the built-in meta-agent shipped with every workspace.
		const [sindre] = await tx
			.insert(actors)
			.values({
				type: SINDRE_DEFAULT.type,
				name: SINDRE_DEFAULT.name,
				isSystem: SINDRE_DEFAULT.isSystem,
				systemPrompt: SINDRE_DEFAULT.systemPrompt,
				llmProvider: SINDRE_DEFAULT.llmProvider,
				llmConfig: SINDRE_DEFAULT.llmConfig,
				tools: SINDRE_DEFAULT.tools,
				createdBy: actorId,
			})
			.returning()

		if (!sindre) throw new Error('Failed to seed Sindre actor')

		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: sindre.id,
			role: 'member',
		})

		return ws
	})

	if (!workspace) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace'), 500)
	}

	return c.json(serialize(workspace) as z.infer<typeof workspaceResponseSchema>, 201)
})

// GET /api/workspaces
const listWorkspacesRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['workspaces'],
	summary: 'List workspaces for current actor',
	responses: {
		200: {
			description: 'List of workspaces',
			content: { 'application/json': { schema: z.array(workspaceWithRoleSchema) } },
		},
	},
})

app.openapi(listWorkspacesRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const results = await db
		.select({
			id: workspaces.id,
			name: workspaces.name,
			settings: workspaces.settings,
			role: workspaceMembers.role,
			createdAt: workspaces.createdAt,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
		.where(eq(workspaceMembers.actorId, actorId))

	return c.json(serializeArray(results) as z.infer<typeof workspaceWithRoleSchema>[])
})

// PATCH /api/workspaces/:id
const updateWorkspaceRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['workspaces'],
	summary: 'Update workspace',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Workspace updated',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateWorkspaceRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.name) updateData.name = body.name
	if (body.settings) {
		// Merge settings with existing. Top-level keys are shallow-merged, but
		// `llm_keys` is deep-merged so concurrent single-provider updates (UI +
		// MCP) don't clobber sibling providers. `null` values inside `llm_keys`
		// are treated as deletions.
		const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
		if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		const existingSettings = (existing.settings ?? {}) as Record<string, unknown>
		const merged: Record<string, unknown> = { ...existingSettings, ...body.settings }
		if (body.settings.llm_keys) {
			const existingLlm = (existingSettings.llm_keys ?? {}) as Record<string, string>
			const mergedLlm: Record<string, string> = { ...existingLlm }
			for (const [k, v] of Object.entries(body.settings.llm_keys)) {
				if (v === null || v === undefined) delete mergedLlm[k]
				else mergedLlm[k] = v
			}
			merged.llm_keys = mergedLlm
		}
		updateData.settings = merged
	}

	const [updated] = await db
		.update(workspaces)
		.set(updateData)
		.where(eq(workspaces.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof workspaceResponseSchema>)
}) as RouteHandler<typeof updateWorkspaceRoute, Env>)

// POST /api/workspaces/:id/members
const addMemberRoute = createRoute({
	method: 'post',
	path: '/{id}/members',
	tags: ['workspaces'],
	summary: 'Add member to workspace',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: addMemberBodySchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Member added',
			content: { 'application/json': { schema: z.object({ added: z.boolean() }) } },
		},
		403: {
			description: 'Caller is not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(addMemberRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId } = c.req.valid('param')
	const { actor_id, role } = c.req.valid('json')

	if (!(await isWorkspaceMember(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: actor_id,
		role: role || 'member',
	})

	return c.json({ added: true }, 201)
}) as RouteHandler<typeof addMemberRoute, Env>)

// GET /api/workspaces/:id/members
const listMembersRoute = createRoute({
	method: 'get',
	path: '/{id}/members',
	tags: ['workspaces'],
	summary: 'List workspace members',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'List of members',
			content: { 'application/json': { schema: z.array(memberResponseSchema) } },
		},
	},
})

app.openapi(listMembersRoute, async (c) => {
	const db = c.get('db')
	const { id: workspaceId } = c.req.valid('param')

	const members = await db
		.select({
			actorId: workspaceMembers.actorId,
			role: workspaceMembers.role,
			joinedAt: workspaceMembers.joinedAt,
			name: actors.name,
			type: actors.type,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))

	return c.json(serializeArray(members) as z.infer<typeof memberResponseSchema>[])
})

// POST /api/workspaces/:id/modules/:moduleId/enable
//
// Enables a built-in module in a workspace. Idempotent — safe to re-run.
// Performs the full settings merge (display_names, statuses, field_definitions,
// relationship_types) and seeds the module's defaultAgents + defaultTriggers
// from the @maskin/module-sdk registry. Existing agents/triggers matched by
// name are skipped, never duplicated or overwritten.
const enableModuleRoute = createRoute({
	method: 'post',
	path: '/{id}/modules/{moduleId}/enable',
	tags: ['workspaces'],
	summary: 'Enable a module in a workspace and seed its agents + triggers',
	request: {
		params: z.object({
			id: z.string().uuid(),
			moduleId: z.string().min(1),
		}),
	},
	responses: {
		200: {
			description: 'Module enabled',
			content: {
				'application/json': {
					schema: z.object({
						workspace: workspaceResponseSchema,
						agents_created: z.number(),
						triggers_created: z.number(),
					}),
				},
			},
		},
		403: {
			description: 'Caller is not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace or module not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(enableModuleRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId, moduleId } = c.req.valid('param')

	if (!(await isWorkspaceMember(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const mod = getModule(moduleId)
	if (!mod) {
		return c.json(createApiError('NOT_FOUND', `Module not found: ${moduleId}`), 404)
	}

	const [existing] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// Merge module defaults into workspace settings. Existing keys win — we
	// only add what isn't already there, so re-enabling never clobbers user
	// customisation.
	const settings = (existing.settings ?? {}) as Record<string, unknown>
	const defaults = mod.defaultSettings ?? {}
	const enabledModules = Array.isArray(settings.enabled_modules)
		? (settings.enabled_modules as string[])
		: ['work']

	const merged: Record<string, unknown> = {
		...settings,
		enabled_modules: enabledModules.includes(moduleId)
			? enabledModules
			: [...enabledModules, moduleId],
		display_names: { ...defaults.display_names, ...((settings.display_names as object) ?? {}) },
		statuses: { ...defaults.statuses, ...((settings.statuses as object) ?? {}) },
		field_definitions: {
			...defaults.field_definitions,
			...((settings.field_definitions as object) ?? {}),
		},
		relationship_types: Array.from(
			new Set([
				...((settings.relationship_types as string[]) ?? []),
				...(defaults.relationship_types ?? []),
			]),
		),
	}

	await db
		.update(workspaces)
		.set({ settings: merged, updatedAt: new Date() })
		.where(eq(workspaces.id, workspaceId))

	// Seed agents — idempotent by name within the workspace. Track $id → real
	// UUID so triggers can resolve their target actor below.
	const actorIdMap: Record<string, string> = {}
	let agentsCreated = 0
	for (const agent of mod.defaultAgents ?? []) {
		const [existingMember] = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, agent.name)))
			.limit(1)

		if (existingMember) {
			actorIdMap[agent.$id] = existingMember.actorId
			continue
		}

		const [created] = await db
			.insert(actors)
			.values({
				type: 'agent',
				name: agent.name,
				systemPrompt: agent.systemPrompt,
				tools: agent.tools,
				createdBy: callerId,
			})
			.returning({ id: actors.id })

		if (!created) continue

		await db.insert(workspaceMembers).values({
			workspaceId,
			actorId: created.id,
			role: 'member',
		})

		actorIdMap[agent.$id] = created.id
		agentsCreated++
	}

	// Seed triggers — idempotent by name within the workspace.
	let triggersCreated = 0
	for (const trigger of mod.defaultTriggers ?? []) {
		const targetActorId = actorIdMap[trigger.targetActor$id]
		if (!targetActorId) continue // referenced agent missing — skip silently

		const [existingTrigger] = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, trigger.name)))
			.limit(1)
		if (existingTrigger) continue

		await db.insert(triggers).values({
			workspaceId,
			name: trigger.name,
			type: trigger.type,
			config: trigger.config,
			actionPrompt: trigger.actionPrompt,
			targetActorId,
			enabled: trigger.enabled,
			createdBy: callerId,
		})
		triggersCreated++
	}

	const [updated] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!updated) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	return c.json({
		workspace: serialize(updated) as z.infer<typeof workspaceResponseSchema>,
		agents_created: agentsCreated,
		triggers_created: triggersCreated,
	})
}) as RouteHandler<typeof enableModuleRoute, Env>)

export default app
