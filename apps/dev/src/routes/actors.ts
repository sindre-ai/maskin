import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { generateApiKey, hashPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	integrations,
	notifications,
	objects,
	relationships,
	sessionLogs,
	sessions,
	triggers,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import {
	SINDRE_DEFAULT,
	createActorSchema,
	updateActorSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import {
	actorListItemSchema,
	actorResponseSchema,
	actorWithKeySchema,
	errorSchema,
	idParamSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
	}
}

/** Default prompt used when /run is invoked with no explicit action_prompt. */
const DEFAULT_RUN_ACTION_PROMPT = 'Resume your assigned work.'

const RUNNING_SESSION_STATUSES = ['pending', 'starting', 'queued', 'running', 'snapshotting']

const app = new OpenAPIHono<Env>()

// POST / - Create actor (signup)
const createActorRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Actors'],
	summary: 'Create actor (signup)',
	request: {
		body: {
			content: {
				'application/json': {
					schema: createActorSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Actor created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor with this ID already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(createActorRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	// Human users must provide email and password
	if (body.type === 'human') {
		if (!body.email) {
			return c.json(
				createApiError('BAD_REQUEST', 'Email is required for human accounts', [
					{ field: 'email', message: 'Required for human accounts' },
				]),
				400,
			)
		}
		if (!body.password) {
			return c.json(
				createApiError('BAD_REQUEST', 'Password is required for human accounts', [
					{ field: 'password', message: 'Required for human accounts' },
				]),
				400,
			)
		}
	}

	// Generate API key
	const { key } = generateApiKey()

	// Hash password if provided
	const passwordHash = body.password ? await hashPassword(body.password) : undefined

	const [actor] = await db
		.insert(actors)
		.values({
			...(body.id && { id: body.id }),
			type: body.type,
			name: body.name,
			email: body.email,
			apiKey: key,
			passwordHash,
			systemPrompt: body.system_prompt,
			tools: body.tools,
			llmProvider: body.llm_provider,
			llmConfig: body.llm_config,
		})
		.onConflictDoNothing({ target: actors.id })
		.returning()

	if (!actor) {
		if (body.id) {
			return c.json(createApiError('BAD_REQUEST', 'An actor with this ID already exists'), 409)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create actor'), 500)
	}

	// Auto-create personal workspace (default true for humans, false for agents)
	const shouldCreateWorkspace = body.auto_create_workspace ?? body.type === 'human'
	let workspaceId: string | undefined

	if (shouldCreateWorkspace) {
		const defaultSettings = workspaceSettingsSchema.parse({})
		const created = await db.transaction(async (tx) => {
			const [workspace] = await tx
				.insert(workspaces)
				.values({
					name: `${body.name}'s Workspace`,
					settings: defaultSettings,
					createdBy: actor.id,
				})
				.returning()

			if (!workspace) return null

			await tx.insert(workspaceMembers).values({
				workspaceId: workspace.id,
				actorId: actor.id,
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
					createdBy: actor.id,
				})
				.returning()

			if (!sindre) throw new Error('Failed to seed Sindre actor')

			await tx.insert(workspaceMembers).values({
				workspaceId: workspace.id,
				actorId: sindre.id,
				role: 'member',
			})

			return workspace
		})

		if (created) workspaceId = created.id
	}

	// Return actor WITHOUT api_key, but WITH it in the expected response field
	const { apiKey: _, ...actorWithoutKey } = actor
	return c.json(
		{
			...serialize(actorWithoutKey),
			api_key: key,
			...(workspaceId && { workspace_id: workspaceId }),
		} as z.infer<typeof actorWithKeySchema>,
		201,
	)
})

// GET / - List actors
const listActorsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Actors'],
	summary: 'List actors',
	request: {
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(actorListItemSchema) } },
			description: 'List of actors',
		},
	},
})

app.openapi(listActorsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (workspaceId) {
		// List actors in workspace
		const members = await db
			.select({
				id: actors.id,
				type: actors.type,
				name: actors.name,
				email: actors.email,
				agentState: actors.agentState,
				role: workspaceMembers.role,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(eq(workspaceMembers.workspaceId, workspaceId))

		return c.json(serializeArray(members) as z.infer<typeof actorListItemSchema>[])
	}

	// List actors across all workspaces the authenticated actor belongs to
	const actorId = c.get('actorId')

	const myWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, actorId))

	const workspaceIds = myWorkspaces.map((w) => w.workspaceId)
	if (workspaceIds.length === 0) {
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	const members = await db
		.selectDistinct({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			agentState: actors.agentState,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(inArray(workspaceMembers.workspaceId, workspaceIds))

	return c.json(serializeArray(members) as z.infer<typeof actorListItemSchema>[])
})

// GET /:id - Get actor by ID
const getActorRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Get actor by ID',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor found',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(getActorRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const [actor] = await db
		.select({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			createdAt: actors.createdAt,
			updatedAt: actors.updatedAt,
		})
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)

	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serialize(actor) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof getActorRoute, Env>)

// PATCH /:id - Update actor
const updateActorRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Update actor',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateActorSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor updated',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(updateActorRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [updated] = await db
		.update(actors)
		.set({
			...(body.name && { name: body.name }),
			...(body.email && { email: body.email }),
			...(body.system_prompt !== undefined && { systemPrompt: body.system_prompt }),
			...(body.tools !== undefined && { tools: body.tools }),
			...(body.memory !== undefined && { memory: body.memory }),
			...(body.llm_provider !== undefined && { llmProvider: body.llm_provider }),
			...(body.llm_config !== undefined && { llmConfig: body.llm_config }),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			updatedAt: actors.updatedAt,
		})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof updateActorRoute, Env>)

// POST /:id/api-keys - Regenerate API key
const regenerateApiKeyRoute = createRoute({
	method: 'post',
	path: '/{id}/api-keys',
	tags: ['Actors'],
	summary: 'Regenerate API key',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ api_key: z.string() }) } },
			description: 'API key regenerated',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(regenerateApiKeyRoute, (async (c) => {
	const db = c.get('db')
	const { id } = c.req.valid('param')

	const { key } = generateApiKey()

	const [updated] = await db
		.update(actors)
		.set({ apiKey: key, updatedAt: new Date() })
		.where(eq(actors.id, id))
		.returning({ id: actors.id })

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json({ api_key: key })
}) as RouteHandler<typeof regenerateApiKeyRoute, Env>)

// POST /:id/reset - Reset system actor to factory defaults (Sindre)
const resetActorRoute = createRoute({
	method: 'post',
	path: '/{id}/reset',
	tags: ['Actors'],
	summary: 'Reset system actor to factory defaults',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor reset to defaults',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor is not a system actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(resetActorRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!existing.isSystem) {
		return c.json(createApiError('FORBIDDEN', 'Only system actors can be reset to defaults'), 403)
	}

	const [updated] = await db
		.update(actors)
		.set({
			name: SINDRE_DEFAULT.name,
			systemPrompt: SINDRE_DEFAULT.systemPrompt,
			llmProvider: SINDRE_DEFAULT.llmProvider,
			llmConfig: SINDRE_DEFAULT.llmConfig,
			tools: SINDRE_DEFAULT.tools,
			memory: null,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			systemPrompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llmProvider: actors.llmProvider,
			llmConfig: actors.llmConfig,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			updatedAt: actors.updatedAt,
		})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'reset',
		entityType: 'actor',
		entityId: id,
		data: updated,
	})

	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof resetActorRoute, Env>)

// DELETE /:id - Delete actor (agents only)
const deleteActorRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Delete actor (agents only)',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Actor deleted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot delete human actors',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(deleteActorRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.isSystem) {
		return c.json(createApiError('FORBIDDEN', 'System agents cannot be deleted'), 403)
	}

	if (existing.type !== 'agent') {
		return c.json(createApiError('FORBIDDEN', 'Only agent actors can be deleted'), 403)
	}

	const existingData = { ...existing }
	await db.transaction(async (tx) => {
		// Delete session logs for sessions owned by this actor
		const actorSessions = await tx
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.actorId, id))
		const sessionIds = actorSessions.map((s) => s.id)
		if (sessionIds.length > 0) {
			await tx.delete(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds))
		}
		await tx.delete(sessions).where(eq(sessions.actorId, id))

		// Delete triggers targeting or created by this actor
		await tx.delete(triggers).where(or(eq(triggers.targetActorId, id), eq(triggers.createdBy, id)))

		// Delete agent files
		await tx.delete(agentFiles).where(eq(agentFiles.actorId, id))

		// Delete notifications
		await tx
			.delete(notifications)
			.where(or(eq(notifications.sourceActorId, id), eq(notifications.targetActorId, id)))

		// Delete events
		await tx.delete(events).where(eq(events.actorId, id))

		// Delete relationships
		await tx.delete(relationships).where(eq(relationships.createdBy, id))

		// Reassign objects
		await tx.update(objects).set({ owner: null }).where(eq(objects.owner, id))
		await tx.update(objects).set({ createdBy: actorId }).where(eq(objects.createdBy, id))

		// Clean up workspace references
		await tx.delete(workspaceMembers).where(eq(workspaceMembers.actorId, id))
		await tx.update(workspaces).set({ createdBy: null }).where(eq(workspaces.createdBy, id))
		await tx.update(integrations).set({ createdBy: actorId }).where(eq(integrations.createdBy, id))

		// Clean up self-references and delete
		await tx.update(actors).set({ createdBy: null }).where(eq(actors.createdBy, id))
		await tx.delete(actors).where(eq(actors.id, id))
	})

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'deleted',
		entityType: 'agent',
		entityId: id,
		data: existingData,
	})

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteActorRoute, Env>)

// Returning shape used by /pause and /run handlers — full actor row.
const actorReturningCols = {
	id: actors.id,
	type: actors.type,
	name: actors.name,
	email: actors.email,
	systemPrompt: actors.systemPrompt,
	tools: actors.tools,
	memory: actors.memory,
	llmProvider: actors.llmProvider,
	llmConfig: actors.llmConfig,
	isSystem: actors.isSystem,
	agentState: actors.agentState,
	agentStateUpdatedAt: actors.agentStateUpdatedAt,
	createdAt: actors.createdAt,
	updatedAt: actors.updatedAt,
} as const

// POST /:id/pause - Pause an agent (and any in-flight session for it)
const pauseAgentRoute = createRoute({
	method: 'post',
	path: '/{id}/pause',
	tags: ['Actors'],
	summary: 'Pause an agent and any in-flight session',
	description:
		'Sets the agent to a paused state. If the agent has a session in `running` state, that session is paused (snapshotted) too.',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Agent paused',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot pause agent',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found in workspace',
		},
	},
})

app.openapi(pauseAgentRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// Pause any currently-running session for this agent. Only `running`
	// sessions can be snapshotted — sessions in pending/starting/queued are
	// stopped instead so we don't leave orphaned containers behind.
	const liveSessions = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.actorId, id),
				eq(sessions.workspaceId, workspaceId),
				inArray(sessions.status, RUNNING_SESSION_STATUSES),
			),
		)
		.orderBy(desc(sessions.createdAt))

	for (const s of liveSessions) {
		try {
			if (s.status === 'running') {
				await sessionManager.pauseSession(s.id)
			} else {
				await sessionManager.stopSession(s.id)
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return c.json(createApiError('BAD_REQUEST', message), 400)
		}
	}

	const [updated] = await db
		.update(actors)
		.set({
			agentState: 'paused',
			agentStateUpdatedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning(actorReturningCols)

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'agent_paused',
		entityType: 'actor',
		entityId: id,
		data: { paused_session_ids: liveSessions.map((s) => s.id) },
	})

	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof pauseAgentRoute, Env>)

// POST /:id/run - Resume a paused agent OR start a fresh session
const runAgentBodySchema = z
	.object({
		action_prompt: z.string().min(1).optional(),
	})
	.optional()

const runAgentRoute = createRoute({
	method: 'post',
	path: '/{id}/run',
	tags: ['Actors'],
	summary: 'Run an agent — resume paused session or start a fresh one',
	description:
		'If the agent has a paused session, it is resumed. Otherwise a fresh session is started using the provided action_prompt (or a default).',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: runAgentBodySchema } },
			required: false,
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Agent running',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot run agent',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found in workspace',
		},
	},
})

app.openapi(runAgentRoute, (async (c) => {
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json') ?? {}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// If there's already a live session, the agent is effectively running —
	// no-op the start logic and just sync the state field.
	const [liveSession] = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.actorId, id),
				eq(sessions.workspaceId, workspaceId),
				inArray(sessions.status, RUNNING_SESSION_STATUSES),
			),
		)
		.orderBy(desc(sessions.createdAt))
		.limit(1)

	if (!liveSession) {
		// Prefer resuming the most recent paused session over creating a new one,
		// so users don't lose context that was snapshotted on Pause.
		const [pausedSession] = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.actorId, id),
					eq(sessions.workspaceId, workspaceId),
					eq(sessions.status, 'paused'),
				),
			)
			.orderBy(desc(sessions.createdAt))
			.limit(1)

		try {
			if (pausedSession) {
				await sessionManager.resumeSession(pausedSession.id)
			} else {
				await sessionManager.createSession(workspaceId, {
					actorId: id,
					actionPrompt: body.action_prompt ?? DEFAULT_RUN_ACTION_PROMPT,
					createdBy: actorId,
				})
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			return c.json(createApiError('BAD_REQUEST', message), 400)
		}
	}

	const [updated] = await db
		.update(actors)
		.set({
			agentState: 'running',
			agentStateUpdatedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning(actorReturningCols)

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'agent_run',
		entityType: 'actor',
		entityId: id,
		data: {},
	})

	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof runAgentRoute, Env>)

export default app
