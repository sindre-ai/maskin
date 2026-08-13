import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	workspaceMembers,
	workspaceOnboardingPrompts,
	workspaces,
} from '@maskin/db/schema'
import {
	WORKSPACE_ADMIN_DIFF_FIELDS,
	WORKSPACE_COACH_DEFAULT,
	computeChanges,
	createWorkspaceSchema,
	updateWorkspaceAdminSchema,
	updateWorkspaceSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError, validationFailureHook } from '../lib/errors'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceResponseSchema } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember, isWorkspaceOwner } from '../lib/workspace-auth'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'
import {
	SeedAgentError,
	bootstrapDefaultAgents,
	seedDefaultAgentActors,
} from '../services/workspace-bootstrap'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
		sessionManager: SessionManager
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

const updateMemberBodySchema = z.object({
	role: z.enum(['owner', 'admin', 'member']),
})

const memberParamSchema = z.object({
	id: z.string().uuid(),
	actorId: z.string().uuid(),
})

const workspaceWithRoleSchema = workspaceResponseSchema.extend({
	role: z.string(),
})

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

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

	let workspace: typeof workspaces.$inferSelect | null
	try {
		workspace = await db.transaction(async (tx) => {
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

			// Seed all default agents (Coach, Chief of Staff, Driver, Strategist,
			// Insights Triage, Research Agent) inside the same transaction. If any
			// one fails the tx rolls back — no half-seeded workspace lingers behind
			// a partial success.
			// Skills, workspace_skill files, and triggers are seeded post-commit
			// because they hit S3 and can't be rolled back inside a DB transaction.
			const agentIds = await seedDefaultAgentActors(tx, ws.id, actorId)

			// Pin Chief of Staff as the default chat agent unless the caller
			// explicitly requested a different (or no) default in the create body.
			if (settings.default_agent_id === undefined && agentIds.chief_of_staff) {
				const nextSettings = { ...settings, default_agent_id: agentIds.chief_of_staff }
				await tx.update(workspaces).set({ settings: nextSettings }).where(eq(workspaces.id, ws.id))
				ws.settings = nextSettings
			}

			return ws
		})
	} catch (err) {
		if (err instanceof SeedAgentError) {
			logger.error('Workspace create rolled back — default agent seed failed', {
				agentId: err.agentId,
				errorClass: err.errorClass,
				cause: err.cause instanceof Error ? err.cause.message : String(err.cause),
			})
			return c.json(
				createApiError(
					'INTERNAL_ERROR',
					`Failed to seed default agent "${err.agentId}": ${err.errorClass}`,
					[
						{ field: 'agent_id', message: err.agentId },
						{ field: 'error_class', message: err.errorClass },
					],
				),
				500,
			)
		}
		throw err
	}

	if (!workspace) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace'), 500)
	}

	// Post-commit: emit workspace_created for the bet's activation-cohort query.
	// Fire-and-forget by design — the analytics client never throws (see posthog.ts).
	void capturePosthogEvent('workspace_created', workspace.id, {
		workspace_id: workspace.id,
		workspace_name: workspace.name,
		created_by: actorId,
	})

	// Post-commit: seed the default agents' skills + triggers. The actor + member
	// rows are already committed by seedDefaultAgentActors, so this call is a
	// no-op for actors (name check hits every one) and only writes
	// workspace_skills + agent_skills + triggers.
	const agentStorage = c.get('agentStorage')
	if (agentStorage) {
		bootstrapDefaultAgents(db, agentStorage, workspace.id, actorId).catch((err) =>
			logger.error('workspace bootstrap failed', { workspaceId: workspace.id, err }),
		)
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
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateWorkspaceRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	// claude_oauth has its own locked, slot-aware, audited read-modify-write
	// routes (POST /api/claude-oauth/import, DELETE /api/claude-oauth,
	// POST /api/claude-oauth/swap) built to prevent concurrent writers from
	// clobbering the other slot or failover state. This route does a shallow,
	// unlocked settings merge, so it must not be allowed to touch claude_oauth
	// at all — otherwise any PATCH body containing `settings.claude_oauth`
	// (including `{}`) would silently overwrite both slots.
	if (body.settings && 'claude_oauth' in body.settings) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'claude_oauth cannot be updated via PATCH /api/workspaces/:id — use /api/claude-oauth instead',
			),
			400,
		)
	}

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

	await db.insert(events).values({
		workspaceId: id,
		actorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: id,
		data: { updated },
	})

	return c.json(serialize(updated) as z.infer<typeof workspaceResponseSchema>)
}) as RouteHandler<typeof updateWorkspaceRoute, Env>)

// PATCH /api/workspaces/admin/:id — flip onboarding_enabled without a code deploy
const updateWorkspaceOnboardingRoute = createRoute({
	method: 'patch',
	path: '/admin/{id}',
	tags: ['workspaces'],
	summary: 'Set onboarding_enabled flag (owner only)',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceAdminSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Workspace updated',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		403: {
			description: 'Caller is not the workspace owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const ONBOARDING_PROMPT_TYPES = [
	'product_vision',
	'icp',
	'first_bet_hypothesis',
	'north_star_metric',
	'customer_evidence',
] as const

app.openapi(updateWorkspaceOnboardingRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
	if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	if (!(await isWorkspaceOwner(db, actorId, id))) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace owner'), 403)
	}

	const [updated] = await db
		.update(workspaces)
		.set({ onboardingEnabled: body.onboarding_enabled, updatedAt: new Date() })
		.where(eq(workspaces.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	if (body.onboarding_enabled) {
		await db
			.insert(workspaceOnboardingPrompts)
			.values(ONBOARDING_PROMPT_TYPES.map((promptType) => ({ workspaceId: id, promptType })))
			.onConflictDoNothing()

		const [coach] = await db
			.select({ id: actors.id })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(eq(workspaceMembers.workspaceId, id), eq(actors.name, WORKSPACE_COACH_DEFAULT.name)),
			)
			.limit(1)

		if (coach) {
			c.get('sessionManager')
				.createSession(id, {
					actorId: coach.id,
					actionPrompt:
						'A workspace has been enabled for onboarding (onboarding_enabled flipped to true). Run the workspace-observer-onboarding skill.\n\nBefore starting: check whether this workspace already has an onboarding_session object. If one exists, exit silently.\n\nIf none exists, follow the workspace-observer-onboarding skill to:\n1. Create the onboarding_session object.\n2. Subscribe the workspace owner.\n3. Post the five context prompts in sequence, waiting for each reply before the next.\n4. Capture each reply as a knowledge object.\n5. Close the session when all prompts are answered (or after 24h).',
					createdBy: actorId,
				})
				.catch((err) =>
					logger.error('Failed to create onboarding session', { workspaceId: id, err }),
				)
		}
	}

	const changes = computeChanges(
		existing as unknown as Record<string, unknown>,
		updated as unknown as Record<string, unknown>,
		WORKSPACE_ADMIN_DIFF_FIELDS,
	)
	await db.insert(events).values({
		workspaceId: id,
		actorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: id,
		data: { changes },
	})

	return c.json(serialize(updated) as z.infer<typeof workspaceResponseSchema>)
}) as RouteHandler<typeof updateWorkspaceOnboardingRoute, Env>)

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

// PATCH /api/workspaces/:id/members/:actorId — change a member's role
const updateMemberRoute = createRoute({
	method: 'patch',
	path: '/{id}/members/{actorId}',
	tags: ['workspaces'],
	summary: "Change a workspace member's role",
	request: {
		params: memberParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateMemberBodySchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Member role updated',
			content: { 'application/json': { schema: memberResponseSchema } },
		},
		400: {
			description: 'Would leave the workspace without an owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Member not found in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateMemberRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId, actorId } = c.req.valid('param')
	const { role } = c.req.valid('json')

	if (!(await isWorkspaceMember(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	if (callerId === actorId) {
		return c.json(
			createApiError('BAD_REQUEST', 'Use account settings to manage your own membership'),
			400,
		)
	}

	const [existing] = await db
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Member not found in this workspace'), 404)
	}

	const result = await db.transaction(async (tx) => {
		// Guardrail inside the transaction: re-check the owner count under the transaction lock
		// so two concurrent demotions cannot both pass the guard before either write commits.
		if (existing.role === 'owner' && role !== 'owner') {
			const owners = await tx
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.where(
					and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
				)
			if (owners.length <= 1) {
				return { kind: 'last_owner_error' } as const
			}
		}

		const [u] = await tx
			.update(workspaceMembers)
			.set({ role })
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
			)
			.returning({
				actorId: workspaceMembers.actorId,
				role: workspaceMembers.role,
				joinedAt: workspaceMembers.joinedAt,
			})

		if (!u) return { kind: 'not_found' } as const

		const [a] = await tx
			.select({ name: actors.name, type: actors.type })
			.from(actors)
			.where(eq(actors.id, actorId))
			.limit(1)

		await tx.insert(events).values({
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'workspace_member',
			entityId: actorId,
			data: { role: { from: existing.role, to: role } },
		})

		return { kind: 'success', updated: u, actor: a } as const
	})

	if (result.kind === 'last_owner_error') {
		return c.json(createApiError('BAD_REQUEST', 'Cannot demote the last owner of a workspace'), 400)
	}
	if (result.kind === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Member not found in this workspace'), 404)
	}

	return c.json(
		serialize({
			actorId: result.updated.actorId,
			role: result.updated.role,
			joinedAt: result.updated.joinedAt,
			name: result.actor?.name ?? '',
			type: result.actor?.type ?? '',
		}) as z.infer<typeof memberResponseSchema>,
	)
}) as RouteHandler<typeof updateMemberRoute, Env>)

// DELETE /api/workspaces/:id/members/:actorId — remove a member
const removeMemberRoute = createRoute({
	method: 'delete',
	path: '/{id}/members/{actorId}',
	tags: ['workspaces'],
	summary: 'Remove a member from a workspace',
	request: {
		params: memberParamSchema,
	},
	responses: {
		200: {
			description: 'Member removed',
			content: { 'application/json': { schema: z.object({ removed: z.boolean() }) } },
		},
		400: {
			description: 'Would leave the workspace without an owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Member not found in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(removeMemberRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId, actorId } = c.req.valid('param')

	if (!(await isWorkspaceMember(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	if (callerId === actorId) {
		return c.json(createApiError('BAD_REQUEST', 'Use account settings to leave a workspace'), 400)
	}

	const [existing] = await db
		.select({ role: workspaceMembers.role })
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Member not found in this workspace'), 404)
	}

	const deleteResult = await db.transaction(async (tx) => {
		// Guardrail inside the transaction: re-check the owner count under the transaction lock
		// so two concurrent removes cannot both pass the guard before either write commits.
		if (existing.role === 'owner') {
			const owners = await tx
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.where(
					and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')),
				)
			if (owners.length <= 1) {
				return { kind: 'last_owner_error' } as const
			}
		}

		const rows = await tx
			.delete(workspaceMembers)
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
			)
			.returning({ actorId: workspaceMembers.actorId })

		if (rows.length > 0) {
			await tx.insert(events).values({
				workspaceId,
				actorId: callerId,
				action: 'deleted',
				entityType: 'workspace_member',
				entityId: actorId,
				data: { role: existing.role },
			})
		}

		return { kind: 'deleted', rows } as const
	})

	if (deleteResult.kind === 'last_owner_error') {
		return c.json(createApiError('BAD_REQUEST', 'Cannot remove the last owner of a workspace'), 400)
	}
	if (deleteResult.rows.length === 0) {
		return c.json(createApiError('NOT_FOUND', 'Member not found in this workspace'), 404)
	}

	return c.json({ removed: true })
}) as RouteHandler<typeof removeMemberRoute, Env>)

export default app
