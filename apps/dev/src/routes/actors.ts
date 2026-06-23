import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { generateApiKey, hashPassword } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	files,
	imports,
	integrations,
	notifications,
	objects,
	readState,
	relationships,
	sessionLogs,
	sessions,
	subscriptions,
	triggers,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import {
	type AgentState,
	PLATFORM_MCP_PRESET,
	WORKSPACE_COACH_DEFAULT,
	createActorSchema,
	updateActorSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, asc, count, countDistinct, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
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
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'
import { bootstrapDefaultAgents } from '../services/workspace-bootstrap'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
		agentStorage: AgentStorageManager
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

function isEmailUniqueViolation(err: unknown): boolean {
	for (let cur: unknown = err; cur && typeof cur === 'object'; ) {
		const e = cur as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === 'actors_email_unique') return true
			if (typeof e.message === 'string' && e.message.includes('actors_email_unique')) return true
		}
		cur = e.cause
	}
	return false
}

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

	// Agents get the Maskin MCP by default — caller-provided servers win on conflict.
	const tools =
		body.type === 'agent'
			? {
					mcpServers: {
						maskin: PLATFORM_MCP_PRESET,
						...(body.tools?.mcpServers ?? {}),
					},
				}
			: body.tools

	let actor: typeof actors.$inferSelect | undefined
	try {
		;[actor] = await db
			.insert(actors)
			.values({
				...(body.id && { id: body.id }),
				type: body.type,
				name: body.name,
				email: body.email,
				apiKey: key,
				passwordHash,
				description: body.description,
				systemPrompt: body.system_prompt,
				tools,
				llmProvider: body.llm_provider,
				llmConfig: body.llm_config,
			})
			.onConflictDoNothing({ target: actors.id })
			.returning()
	} catch (err) {
		if (isEmailUniqueViolation(err)) {
			return c.json(
				createApiError('CONFLICT', 'Email already exists', [
					{ field: 'email', message: 'An account with this email already exists' },
				]),
				409,
			)
		}
		throw err
	}

	if (!actor) {
		if (body.id) {
			return c.json(createApiError('CONFLICT', 'An actor with this ID already exists'), 409)
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

			// Seed Workspace Coach — the built-in meta-agent shipped with every workspace.
			// apiKey is required: without it, the agent's container boots with an empty
			// Bearer token and MCP writes either 401 or — worse — fall back to a key
			// that resolves to a different actor, misattributing every comment.
			const [coach] = await tx
				.insert(actors)
				.values({
					type: WORKSPACE_COACH_DEFAULT.type,
					name: WORKSPACE_COACH_DEFAULT.name,
					isSystem: WORKSPACE_COACH_DEFAULT.isSystem,
					systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
					llmProvider: WORKSPACE_COACH_DEFAULT.llmProvider,
					llmConfig: WORKSPACE_COACH_DEFAULT.llmConfig,
					tools: WORKSPACE_COACH_DEFAULT.tools,
					apiKey: generateApiKey().key,
					createdBy: actor.id,
				})
				.returning()

			if (!coach) throw new Error('Failed to seed Workspace Coach actor')

			await tx.insert(workspaceMembers).values({
				workspaceId: workspace.id,
				actorId: coach.id,
				role: 'member',
			})

			return workspace
		})

		if (created) {
			workspaceId = created.id
			const agentStorage = c.get('agentStorage')
			if (agentStorage) {
				await bootstrapDefaultAgents(db, agentStorage, created.id, actor.id).catch((err) =>
					logger.error('workspace bootstrap failed', { workspaceId: created.id, err }),
				)
			}
		}
	}

	// Return actor WITHOUT api_key, but WITH it in the expected response field.
	// Field names must be snake_case to match actorResponseSchema so MCP read→update
	// round trips don't get keys stripped.
	const { apiKey: _, systemPrompt, llmProvider, llmConfig, ...actorWithoutKey } = actor
	return c.json(
		{
			...serialize(actorWithoutKey),
			system_prompt: systemPrompt,
			llm_provider: llmProvider,
			llm_config: llmConfig,
			api_key: key,
			...(workspaceId && { workspace_id: workspaceId }),
		} as z.infer<typeof actorWithKeySchema>,
		201,
	)
})

// Pagination is opt-in: when `limit`/`offset` are absent, the endpoint returns
// every actor (preserving the historical frontend behaviour). When `limit`
// is present, the result is capped at min(limit, 100) and `X-Total-Count`
// surfaces the real total so MCP/widget callers can render an accurate
// `+N more` footer without changing the array body shape.
// Cap the `ids=` filter at 200 entries per request. Sized for the hero-card
// owner-resolution caller (one ID per object in a tool response) plus headroom.
const MAX_IDS_FILTER = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseIdsParam(
	raw: string | undefined,
): { ok: true; ids: string[] | null } | { ok: false } {
	if (raw === undefined || raw === '') return { ok: true, ids: null }
	const seen = new Set<string>()
	for (const part of raw.split(',')) {
		const trimmed = part.trim()
		if (!trimmed) continue
		if (!UUID_RE.test(trimmed)) return { ok: false }
		seen.add(trimmed.toLowerCase())
		if (seen.size > MAX_IDS_FILTER) return { ok: false }
	}
	return { ok: true, ids: [...seen] }
}

const listActorsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
	ids: z
		.string()
		.optional()
		.openapi({
			description: `Comma-separated list of actor UUIDs to filter by. Max ${MAX_IDS_FILTER} entries.`,
			example: '00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002',
		}),
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
		query: listActorsQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(actorListItemSchema) } },
			description: 'List of actors',
			headers: z.object({
				'x-total-count': z
					.string()
					.describe('Total actor count for the scope, ignoring limit/offset'),
			}),
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(listActorsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { limit, offset, ids: idsParam } = c.req.valid('query')

	const parsed = parseIdsParam(idsParam)
	if (!parsed.ok) {
		return c.json(
			createApiError('BAD_REQUEST', `ids must be comma-separated UUIDs (max ${MAX_IDS_FILTER})`),
			400,
		)
	}
	const idsFilter = parsed.ids

	if (idsFilter !== null && idsFilter.length === 0) {
		c.header('X-Total-Count', '0')
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	if (workspaceId) {
		// Workspace-scoped listing
		const idsCondition = idsFilter ? [inArray(actors.id, idsFilter)] : []
		const wsWhere = idsCondition.length
			? and(eq(workspaceMembers.workspaceId, workspaceId), ...idsCondition)
			: eq(workspaceMembers.workspaceId, workspaceId)

		if (limit === undefined) {
			const members = await db
				.select({
					id: actors.id,
					type: actors.type,
					name: actors.name,
					email: actors.email,
					description: actors.description,
					isSystem: actors.isSystem,
					agentState: actors.agentState,
					role: workspaceMembers.role,
				})
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(wsWhere)

			c.header('X-Total-Count', String(members.length))
			return c.json(serializeArray(members) as z.infer<typeof actorListItemSchema>[])
		}

		const [members, totalRow] = await Promise.all([
			db
				.select({
					id: actors.id,
					type: actors.type,
					name: actors.name,
					email: actors.email,
					description: actors.description,
					isSystem: actors.isSystem,
					agentState: actors.agentState,
					role: workspaceMembers.role,
				})
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(wsWhere)
				.orderBy(asc(actors.name), asc(actors.id))
				.limit(limit)
				.offset(offset ?? 0),
			db
				.select({ value: count() })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(wsWhere),
		])

		c.header('X-Total-Count', String(totalRow[0]?.value ?? 0))
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
		c.header('X-Total-Count', '0')
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	const baseQuery = () =>
		db
			.select({
				id: actors.id,
				type: actors.type,
				name: actors.name,
				email: actors.email,
				description: actors.description,
				isSystem: actors.isSystem,
				agentState: actors.agentState,
				workspaceId: workspaces.id,
				workspaceName: workspaces.name,
				role: workspaceMembers.role,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))

	const crossWhere = idsFilter
		? and(inArray(workspaceMembers.workspaceId, workspaceIds), inArray(actors.id, idsFilter))
		: inArray(workspaceMembers.workspaceId, workspaceIds)

	if (limit === undefined) {
		const rows = await baseQuery()
			.where(crossWhere)
			.orderBy(asc(actors.name), asc(actors.id), asc(workspaces.name), asc(workspaces.id))
		const grouped = groupActorMemberships(rows)
		c.header('X-Total-Count', String(grouped.length))
		return c.json(serializeArray(grouped) as z.infer<typeof actorListItemSchema>[])
	}

	// Two phases: (1) count + pick paginated set of distinct actor IDs ordered
	// by name, then (2) fetch all membership rows for that set and group in
	// JS. This keeps a hard cap on rows transferred even when an actor sits in
	// many workspaces, and keeps `X-Total-Count` exact regardless of fan-out.
	const [totalRow, pageActorRows] = await Promise.all([
		db
			.select({ value: countDistinct(actors.id) })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(crossWhere),
		db
			.selectDistinct({ id: actors.id, name: actors.name })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(crossWhere)
			.orderBy(asc(actors.name), asc(actors.id))
			.limit(limit)
			.offset(offset ?? 0),
	])

	const pageActorIds = pageActorRows.map((r) => r.id)
	if (pageActorIds.length === 0) {
		c.header('X-Total-Count', String(totalRow[0]?.value ?? 0))
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	const rows = await baseQuery()
		.where(
			and(inArray(workspaceMembers.workspaceId, workspaceIds), inArray(actors.id, pageActorIds)),
		)
		.orderBy(asc(actors.name), asc(actors.id), asc(workspaces.name), asc(workspaces.id))

	c.header('X-Total-Count', String(totalRow[0]?.value ?? 0))
	return c.json(
		serializeArray(groupActorMemberships(rows)) as z.infer<typeof actorListItemSchema>[],
	)
}) as RouteHandler<typeof listActorsRoute, Env>)

interface ActorMembershipRow {
	id: string
	type: string
	name: string
	email: string | null
	description: string | null
	isSystem: boolean
	agentState: AgentState
	workspaceId: string
	workspaceName: string
	role: string
}

function groupActorMemberships(rows: ActorMembershipRow[]): Array<{
	id: string
	type: string
	name: string
	email: string | null
	description: string | null
	isSystem: boolean
	agentState: AgentState
	workspaces: { id: string; name: string; role: string }[]
}> {
	const byActor = new Map<
		string,
		{
			id: string
			type: string
			name: string
			email: string | null
			description: string | null
			isSystem: boolean
			agentState: AgentState
			workspaces: { id: string; name: string; role: string }[]
		}
	>()
	for (const r of rows) {
		const membership = { id: r.workspaceId, name: r.workspaceName, role: r.role }
		const existing = byActor.get(r.id)
		if (existing) {
			existing.workspaces.push(membership)
		} else {
			byActor.set(r.id, {
				id: r.id,
				type: r.type,
				name: r.name,
				email: r.email,
				description: r.description,
				isSystem: r.isSystem,
				agentState: r.agentState,
				workspaces: [membership],
			})
		}
	}
	return [...byActor.values()]
}

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
			description: actors.description,
			system_prompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llm_provider: actors.llmProvider,
			llm_config: actors.llmConfig,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			createdAt: actors.createdAt,
			updatedAt: actors.updatedAt,
			installedPackageId: sql<string | null>`${actors.metadata}->>'installed_package_id'`,
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
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
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
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const [existing] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type === 'human' && id !== actorId) {
		if (!workspaceId) {
			return c.json(createApiError('FORBIDDEN', 'Workspace context is required'), 403)
		}

		const [callerMembership] = await db
			.select({ role: workspaceMembers.role })
			.from(workspaceMembers)
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
			)
			.limit(1)

		if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
			return c.json(createApiError('FORBIDDEN', 'Only workspace admins can update humans'), 403)
		}

		if (!(await isWorkspaceMember(db, id, workspaceId))) {
			return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
		}
	}

	const [updated] = await db
		.update(actors)
		.set({
			...(body.name && { name: body.name }),
			...(body.email && { email: body.email }),
			...(body.description !== undefined && { description: body.description }),
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
			description: actors.description,
			system_prompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llm_provider: actors.llmProvider,
			llm_config: actors.llmConfig,
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

// POST /:id/reset - Reset system actor to factory defaults (Workspace Coach)
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
			name: WORKSPACE_COACH_DEFAULT.name,
			description: null,
			systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
			llmProvider: WORKSPACE_COACH_DEFAULT.llmProvider,
			llmConfig: WORKSPACE_COACH_DEFAULT.llmConfig,
			tools: WORKSPACE_COACH_DEFAULT.tools,
			memory: null,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			description: actors.description,
			system_prompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llm_provider: actors.llmProvider,
			llm_config: actors.llmConfig,
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
		// Sessions this agent kicked off for other actors still exist; reassign
		// the creator so the sessions.created_by FK doesn't block the delete.
		await tx.update(sessions).set({ createdBy: actorId }).where(eq(sessions.createdBy, id))

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

		// Delete per-actor feed bookkeeping
		await tx.delete(subscriptions).where(eq(subscriptions.actorId, id))
		await tx.delete(readState).where(eq(readState.actorId, id))

		// Reassign objects
		await tx.update(objects).set({ driver: null }).where(eq(objects.driver, id))
		await tx.update(objects).set({ createdBy: actorId }).where(eq(objects.createdBy, id))

		// Reassign workspace artifacts authored by this agent
		await tx.update(files).set({ createdBy: actorId }).where(eq(files.createdBy, id))
		await tx.update(imports).set({ createdBy: actorId }).where(eq(imports.createdBy, id))
		await tx
			.update(workspaceSkills)
			.set({ createdBy: null })
			.where(eq(workspaceSkills.createdBy, id))

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
	description: actors.description,
	system_prompt: actors.systemPrompt,
	tools: actors.tools,
	memory: actors.memory,
	llm_provider: actors.llmProvider,
	llm_config: actors.llmConfig,
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

	// Verify workspace membership before leaking anything about the actor (e.g.
	// its type), so a member of one workspace can't probe actors in another.
	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type !== 'agent') {
		return c.json(createApiError('BAD_REQUEST', 'Actor is not an agent'), 400)
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

	const failedSessionIds: string[] = []
	for (const s of liveSessions) {
		try {
			if (s.status === 'running') {
				await sessionManager.pauseSession(s.id)
			} else {
				await sessionManager.stopSession(s.id)
			}
		} catch (err) {
			failedSessionIds.push(s.id)
			logger.warn('Failed to pause/stop session during agent pause', {
				sessionId: s.id,
				error: err instanceof Error ? err.message : String(err),
			})
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
		data: {
			paused_session_ids: liveSessions.map((s) => s.id),
			failed_session_ids: failedSessionIds,
		},
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

	// Verify workspace membership before leaking anything about the actor (e.g.
	// its type), so a member of one workspace can't probe actors in another.
	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type !== 'agent') {
		return c.json(createApiError('BAD_REQUEST', 'Actor is not an agent'), 400)
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
