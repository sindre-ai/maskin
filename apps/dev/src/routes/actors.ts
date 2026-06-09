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
	userDisplaySettings,
	webhookDeliveries,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import {
	PLATFORM_MCP_PRESET,
	SINDRE_DEFAULT,
	createActorSchema,
	notificationPrefsSchema,
	updateActorSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, asc, count, countDistinct, eq, inArray, ne, or } from 'drizzle-orm'
import { serializeActor, serializeActorWithKey } from '../lib/actor-response'
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
import { emitProfileFieldChanged } from '../lib/profile-telemetry'
import { serializeArray } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		storageProvider: StorageProvider
	}
}

const MAX_AVATAR_BYTES = 5 * 1024 * 1024

function avatarStorageKey(actorId: string, ext: string): string {
	return `actors/${actorId}/avatar.${ext}`
}

function mimeToExt(mime: string): string | null {
	if (mime === 'image/jpeg') return 'jpg'
	if (mime === 'image/png') return 'png'
	if (mime === 'image/webp') return 'webp'
	return null
}

// Verify the file's leading bytes match the format the client claims. The
// route otherwise trusts `file.type`; a JPEG-tagged HTML/JS blob served with a
// permissive Content-Disposition would be an XSS vector.
function detectImageFormat(bytes: Buffer): 'jpg' | 'png' | 'webp' | null {
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return 'jpg'
	}
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return 'png'
	}
	if (
		bytes.length >= 12 &&
		bytes.toString('ascii', 0, 4) === 'RIFF' &&
		bytes.toString('ascii', 8, 12) === 'WEBP'
	) {
		return 'webp'
	}
	return null
}

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

	const [actor] = await db
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
			// apiKey is required: without it, Sindre's container boots with an empty
			// Bearer token and MCP writes either 401 or — worse — fall back to a key
			// that resolves to a different actor, misattributing every comment.
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
					apiKey: generateApiKey().key,
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

	return c.json(serializeActorWithKey(actor, key, workspaceId), 201)
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

	const [actor] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)

	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	return c.json(serializeActor(actor))
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
		.select({
			type: actors.type,
			notificationPrefs: actors.notificationPrefs,
		})
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

	// Merge partial notification_prefs onto the existing object so callers can
	// flip one switch without resending the whole shape.
	const mergedPrefs =
		body.notification_prefs !== undefined
			? notificationPrefsSchema.parse({
					...(existing.notificationPrefs as Record<string, unknown> | null),
					...body.notification_prefs,
				})
			: undefined

	const [updated] = await db
		.update(actors)
		.set({
			...(body.name && { name: body.name }),
			...(body.description !== undefined && { description: body.description }),
			...(body.bio !== undefined && { bio: body.bio }),
			...(mergedPrefs !== undefined && { notificationPrefs: mergedPrefs }),
			...(body.system_prompt !== undefined && { systemPrompt: body.system_prompt }),
			...(body.tools !== undefined && { tools: body.tools }),
			...(body.memory !== undefined && { memory: body.memory }),
			...(body.llm_provider !== undefined && { llmProvider: body.llm_provider }),
			...(body.llm_config !== undefined && { llmConfig: body.llm_config }),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// Telemetry — one event per profile field actually written. Only humans
	// editing their own profile count toward the bet's ≥70% adoption metric.
	if (id === actorId && existing.type === 'human') {
		if (body.name !== undefined) await emitProfileFieldChanged(db, id, 'name')
		if (body.bio !== undefined) await emitProfileFieldChanged(db, id, 'bio')
		if (body.notification_prefs !== undefined) {
			await emitProfileFieldChanged(db, id, 'notification_prefs')
		}
	}

	return c.json(serializeActor(updated))
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

// POST /:id/avatar — upload avatar
const uploadAvatarRoute = createRoute({
	method: 'post',
	path: '/{id}/avatar',
	tags: ['Actors'],
	summary: 'Upload actor avatar',
	request: {
		params: idParamSchema,
		// Hono passes through multipart form data unparsed; the schema is just
		// documentation here. Actual parsing happens via c.req.formData().
		body: {
			content: {
				'multipart/form-data': {
					schema: z.object({ file: z.unknown() }),
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Avatar uploaded',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid avatar',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Forbidden',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(uploadAvatarRoute, (async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const callerId = c.get('actorId')
	const { id } = c.req.valid('param')

	if (id !== callerId) {
		return c.json(
			createApiError('FORBIDDEN', 'Avatar can only be set by the actor themselves'),
			403,
		)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	let form: FormData
	try {
		form = await c.req.formData()
	} catch (err) {
		logger.error('Avatar upload: failed to parse multipart body', {
			actorId: id,
			error: String(err),
		})
		return c.json(createApiError('BAD_REQUEST', 'Invalid multipart body'), 400)
	}

	const file = form.get('file')
	if (!file || !(file instanceof File)) {
		return c.json(createApiError('BAD_REQUEST', 'Missing "file" field'), 400)
	}

	if (file.size > MAX_AVATAR_BYTES) {
		return c.json(createApiError('BAD_REQUEST', 'Avatar must be 5MB or smaller'), 400)
	}

	const declaredExt = mimeToExt(file.type)
	if (!declaredExt) {
		return c.json(
			createApiError('BAD_REQUEST', 'Avatar must be JPEG, PNG, or WebP', [
				{ field: 'file', message: `Unsupported mime type: ${file.type || 'unknown'}` },
			]),
			400,
		)
	}

	let bytes: Buffer
	try {
		bytes = Buffer.from(await file.arrayBuffer())
	} catch (err) {
		logger.error('Avatar upload: failed to read body', { actorId: id, error: String(err) })
		return c.json(createApiError('BAD_REQUEST', 'Failed to read uploaded file'), 400)
	}

	const detectedExt = detectImageFormat(bytes)
	if (!detectedExt || detectedExt !== declaredExt) {
		logger.warn('Avatar upload: magic-byte mismatch', {
			actorId: id,
			declaredMime: file.type,
			detected: detectedExt ?? 'unknown',
		})
		return c.json(
			createApiError('BAD_REQUEST', 'Avatar bytes do not match a JPEG, PNG, or WebP image', [
				{
					field: 'file',
					message: `Declared ${file.type}, detected ${detectedExt ?? 'unknown'}`,
				},
			]),
			400,
		)
	}

	const storageKey = avatarStorageKey(id, detectedExt)
	try {
		await storage.put(storageKey, bytes)
	} catch (err) {
		logger.error('Avatar upload: storage put failed', { actorId: id, error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to store avatar'), 500)
	}

	// Best-effort cleanup of the just-stored blob when the metadata write fails.
	// Logged-not-thrown: a failing delete must not mask the original 404/500 the
	// caller needs to see. The blob is the only thing that becomes an orphan.
	const cleanupOrphan = async (reason: string) => {
		try {
			await storage.delete(storageKey)
		} catch (cleanupErr) {
			logger.warn('Avatar upload: orphan cleanup failed', {
				actorId: id,
				storageKey,
				reason,
				error: String(cleanupErr),
			})
		}
	}

	// If the prior avatar lived under a different extension, leave the old object
	// behind for now — S3 lifecycle policies will collect it. Overwriting the
	// metadata column is the only thing that matters for serving the new one.
	let rows: (typeof actors.$inferSelect)[]
	try {
		rows = await db
			.update(actors)
			.set({ avatarStorageKey: storageKey, updatedAt: new Date() })
			.where(eq(actors.id, id))
			.returning()
	} catch (err) {
		logger.error('Avatar upload: actor update failed', { actorId: id, error: String(err) })
		await cleanupOrphan('update_threw')
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to store avatar'), 500)
	}

	const [updated] = rows
	if (!updated) {
		await cleanupOrphan('actor_missing')
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await emitProfileFieldChanged(db, id, 'avatar')

	logger.info('Avatar upload: stored', {
		actorId: id,
		storageKey,
		format: detectedExt,
		sizeBytes: bytes.length,
	})

	return c.json(serializeActor(updated))
}) as RouteHandler<typeof uploadAvatarRoute, Env>)

// GET /:id/avatar — serve the stored avatar blob (public, no auth required)
app.get('/:id/avatar', async (c) => {
	const db = c.get('db')
	const storage = c.get('storageProvider')
	const id = c.req.param('id')

	const [actor] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)
	if (!actor?.avatarStorageKey) {
		return c.json(createApiError('NOT_FOUND', 'No avatar'), 404)
	}

	let bytes: Buffer
	try {
		bytes = await storage.get(actor.avatarStorageKey)
	} catch (err) {
		logger.warn('Avatar serve: storage get failed', { actorId: id, error: String(err) })
		return c.json(createApiError('NOT_FOUND', 'Avatar not found'), 404)
	}

	const ext = actor.avatarStorageKey.split('.').pop() ?? ''
	const contentType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'

	logger.info('Avatar serve: hit', { actorId: id, sizeBytes: bytes.length })

	return c.newResponse(new Uint8Array(bytes), 200, {
		'Content-Type': contentType,
		'Cache-Control': 'public, max-age=31536000, immutable',
	})
})

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
			description: null,
			systemPrompt: SINDRE_DEFAULT.systemPrompt,
			llmProvider: SINDRE_DEFAULT.llmProvider,
			llmConfig: SINDRE_DEFAULT.llmConfig,
			tools: SINDRE_DEFAULT.tools,
			memory: null,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning()

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

	return c.json(serializeActor(updated))
}) as RouteHandler<typeof resetActorRoute, Env>)

// DELETE /:id - Delete actor (agent: workspace-scoped; human: self-delete + cascade)
const deleteActorRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Delete actor (agents: workspace-scoped; humans: self-delete the account)',
	request: {
		params: idParamSchema,
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Actor deleted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Forbidden',
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

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.isSystem) {
		return c.json(createApiError('FORBIDDEN', 'System actors cannot be deleted'), 403)
	}

	// Human self-delete branch — implements T1's contract: hard-delete
	// solely-owned workspaces, reassign authored content in shared ones to
	// that workspace's Sindre actor.
	if (existing.type === 'human') {
		if (id !== actorId) {
			return c.json(createApiError('FORBIDDEN', 'Humans can only delete their own account'), 403)
		}

		const memberships = await db
			.select({ workspaceId: workspaceMembers.workspaceId })
			.from(workspaceMembers)
			.where(eq(workspaceMembers.actorId, id))
		const userWorkspaceIds = memberships.map((m) => m.workspaceId)

		await db.transaction(async (tx) => {
			for (const wsId of userWorkspaceIds) {
				const [{ count: otherHumanCount } = { count: 0 }] = await tx
					.select({ count: count() })
					.from(workspaceMembers)
					.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
					.where(
						and(
							eq(workspaceMembers.workspaceId, wsId),
							eq(actors.type, 'human'),
							ne(actors.id, id),
						),
					)

				if (otherHumanCount === 0) {
					// Solely-owned workspace: hard-delete every workspace-scoped row.
					// Order matters: clear FK dependents before parents. workspace_skills,
					// files, user_display_settings, and mcp_telemetry already cascade —
					// they'll go when the workspace row drops.
					await tx.delete(events).where(eq(events.workspaceId, wsId))
					await tx.delete(notifications).where(eq(notifications.workspaceId, wsId))
					await tx
						.delete(relationships)
						.where(
							inArray(
								relationships.sourceId,
								tx.select({ id: objects.id }).from(objects).where(eq(objects.workspaceId, wsId)),
							),
						)
					await tx
						.delete(relationships)
						.where(
							inArray(
								relationships.targetId,
								tx.select({ id: objects.id }).from(objects).where(eq(objects.workspaceId, wsId)),
							),
						)
					await tx.delete(objects).where(eq(objects.workspaceId, wsId))
					await tx.delete(integrations).where(eq(integrations.workspaceId, wsId))
					await tx.delete(triggers).where(eq(triggers.workspaceId, wsId))
					await tx.delete(subscriptions).where(eq(subscriptions.workspaceId, wsId))
					await tx.delete(readState).where(eq(readState.workspaceId, wsId))
					await tx.delete(imports).where(eq(imports.workspaceId, wsId))
					await tx.delete(agentFiles).where(eq(agentFiles.workspaceId, wsId))
					// session_logs FK → sessions; sessions FK → workspaces.
					const wsSessions = await tx
						.select({ id: sessions.id })
						.from(sessions)
						.where(eq(sessions.workspaceId, wsId))
					if (wsSessions.length > 0) {
						await tx.delete(sessionLogs).where(
							inArray(
								sessionLogs.sessionId,
								wsSessions.map((s) => s.id),
							),
						)
					}
					await tx.delete(sessions).where(eq(sessions.workspaceId, wsId))
					await tx.delete(webhookDeliveries).where(eq(webhookDeliveries.workspaceId, wsId))
					await tx.delete(userDisplaySettings).where(eq(userDisplaySettings.workspaceId, wsId))
					await tx.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, wsId))
					await tx.delete(workspaces).where(eq(workspaces.id, wsId))
				} else {
					// Shared workspace: reassign user-authored content to that
					// workspace's Sindre actor so the trail stays visible to teammates.
					const [sindreRow] = await tx
						.select({ id: actors.id })
						.from(workspaceMembers)
						.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
						.where(
							and(
								eq(workspaceMembers.workspaceId, wsId),
								eq(actors.isSystem, true),
								eq(actors.type, 'agent'),
							),
						)
						.limit(1)

					if (!sindreRow) {
						throw new Error(
							`Cannot reassign authored content in workspace ${wsId}: no Sindre actor`,
						)
					}

					await tx
						.update(objects)
						.set({ createdBy: sindreRow.id })
						.where(and(eq(objects.workspaceId, wsId), eq(objects.createdBy, id)))
					await tx
						.update(objects)
						.set({ owner: null })
						.where(and(eq(objects.workspaceId, wsId), eq(objects.owner, id)))
					await tx
						.update(files)
						.set({ createdBy: sindreRow.id })
						.where(and(eq(files.workspaceId, wsId), eq(files.createdBy, id)))
					await tx
						.update(integrations)
						.set({ createdBy: sindreRow.id })
						.where(and(eq(integrations.workspaceId, wsId), eq(integrations.createdBy, id)))
					await tx
						.update(imports)
						.set({ createdBy: sindreRow.id })
						.where(and(eq(imports.workspaceId, wsId), eq(imports.createdBy, id)))
					await tx
						.update(sessions)
						.set({ createdBy: sindreRow.id })
						.where(and(eq(sessions.workspaceId, wsId), eq(sessions.createdBy, id)))
					await tx
						.update(sessions)
						.set({ actorId: sindreRow.id })
						.where(and(eq(sessions.workspaceId, wsId), eq(sessions.actorId, id)))
					// Events authored by this user stay — they are an audit trail.
					// Reassign actor_id to Sindre so the FK doesn't block the actor delete.
					await tx
						.update(events)
						.set({ actorId: sindreRow.id })
						.where(and(eq(events.workspaceId, wsId), eq(events.actorId, id)))
					await tx
						.update(workspaces)
						.set({ createdBy: sindreRow.id })
						.where(and(eq(workspaces.id, wsId), eq(workspaces.createdBy, id)))
					await tx
						.delete(subscriptions)
						.where(and(eq(subscriptions.workspaceId, wsId), eq(subscriptions.actorId, id)))
					await tx
						.delete(readState)
						.where(and(eq(readState.workspaceId, wsId), eq(readState.actorId, id)))
					await tx
						.delete(workspaceMembers)
						.where(and(eq(workspaceMembers.workspaceId, wsId), eq(workspaceMembers.actorId, id)))
				}
			}

			// Actor-level cleanup. Sessions and notifications belonging to this
			// human across workspaces have already been deleted via the per-ws
			// loops above, but a defensive sweep covers any rows that slipped
			// through (e.g. orphaned sessions whose workspace was already gone).
			await tx.delete(notifications).where(eq(notifications.targetActorId, id))
			await tx.delete(notifications).where(eq(notifications.sourceActorId, id))
			// Any session still pointing at this actor at this stage is an orphan
			// from a workspace already removed; delete it rather than NULLing a
			// NOT NULL column.
			await tx.delete(sessions).where(eq(sessions.createdBy, id))
			await tx.delete(sessions).where(eq(sessions.actorId, id))
			await tx.update(actors).set({ createdBy: null }).where(eq(actors.createdBy, id))
			await tx.delete(actors).where(eq(actors.id, id))
		})

		logger.info('Human actor self-deleted', { actorId: id, workspaces: userWorkspaceIds.length })

		return c.json({ deleted: true })
	}

	// Agent delete: requires workspace context, only deletes from that workspace's perspective.
	if (!workspaceId) {
		return c.json(createApiError('BAD_REQUEST', 'X-Workspace-Id required for agent deletion'), 400)
	}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type !== 'agent') {
		return c.json(
			createApiError('FORBIDDEN', 'Only agent actors can be deleted via this path'),
			403,
		)
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
		await tx.update(objects).set({ owner: null }).where(eq(objects.owner, id))
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

export default app
