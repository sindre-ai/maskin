import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	files,
	objects,
	readState,
	relationships,
	subscriptions,
	workspaces,
} from '@maskin/db/schema'
import { getAllValidTypes, getEnabledModuleIds } from '@maskin/module-sdk'
import {
	type ActorRef,
	MAX_BULK_AFFECTED_ROWS,
	type ObjectsFilter,
	bulkDeleteObjectsSchema,
	bulkUpdateObjectsResponseSchema,
	bulkUpdateObjectsSchema,
	createObjectSchema,
	formatEventDescription,
	migrateObjectTypeResponseSchema,
	migrateObjectTypeSchema,
	objectQuerySchema,
	searchObjectsSchema,
	updateObjectSchema,
} from '@maskin/shared'
import {
	type Column,
	type SQL,
	and,
	asc,
	count,
	desc,
	eq,
	ilike,
	inArray,
	or,
	sql,
} from 'drizzle-orm'
import { createApiError, createInvalidTypeError } from '../lib/errors'
import { fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'
import {
	errorSchema,
	idParamSchema,
	objectGraphResponseSchema,
	objectResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import type { WorkspaceSettings } from '../lib/types'
import { isWorkspaceMember } from '../lib/workspace-auth'
import {
	autoSubscribe,
	getSubscriberCount,
	getUnreadCount,
	isSubscribed,
} from '../services/subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Keep in sync with KNOWN_SORT_COLUMNS in packages/shared/src/schemas/objects.ts
const sortColumns: Record<string, Column | SQL> = {
	createdAt: objects.createdAt,
	updatedAt: objects.updatedAt,
	title: objects.title,
	status: objects.status,
	type: objects.type,
	owner: objects.owner,
	createdBy: objects.createdBy,
}

/** Resolve sort expression — built-in column or metadata->>'field_name'. Returns null for unknown/unsafe fields. */
function resolveSortColumn(sortField: string): Column | SQL | null {
	if (sortColumns[sortField]) return sortColumns[sortField]
	if (sortField.startsWith('metadata.')) {
		const fieldName = sortField.slice(9)
		// Safety check: only allow alphanumeric + underscore field names to prevent SQL injection via sql.raw
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fieldName)) return null
		return sql`${objects.metadata}->>'${sql.raw(fieldName)}'`
	}
	return null
}

/**
 * Resolve sort + order into Drizzle orderBy expressions.
 * Falls back to createdAt desc for unknown/unsafe sort fields so objects never disappear.
 *
 * Always appends `objects.id` as a tiebreaker so OFFSET/LIMIT pagination stays
 * stable when the primary sort column has ties — without it, rows sharing a
 * `createdAt` (or any non-unique sort key) can re-appear across pages.
 */
function resolveOrderBy(query: { sort: string; order: string }): SQL[] {
	const sortExpr = resolveSortColumn(query.sort) ?? objects.createdAt
	const primary = query.order === 'desc' ? desc(sortExpr) : asc(sortExpr)
	return [primary, asc(objects.id)]
}

/**
 * Build the WHERE conditions for an objects query that's scoped to a single
 * workspace plus an optional filter predicate. Shared between list, search,
 * and the filter-scoped bulk endpoints so the row-selection rules can't drift.
 *
 * `q` runs against title + content with ILIKE (matching searchObjectsRoute).
 * `status` and `owner` accept comma-lists. `ids` accepts a comma-list of UUIDs
 * — unparseable entries are silently dropped rather than 400'd so a stale
 * notification link doesn't blow up the page.
 */
function buildObjectsWhere(workspaceId: string, filter: ObjectsFilter): SQL[] {
	const conditions: SQL[] = [eq(objects.workspaceId, workspaceId)]
	if (filter.q) {
		const escaped = filter.q.replace(/[%_\\]/g, '\\$&')
		const pattern = `%${escaped}%`
		const textMatch = or(ilike(objects.title, pattern), ilike(objects.content, pattern))
		if (textMatch) conditions.push(textMatch)
	}
	if (filter.type) conditions.push(eq(objects.type, filter.type))
	if (filter.status) {
		const statuses = filter.status.split(',').filter(Boolean)
		if (statuses.length === 1) conditions.push(eq(objects.status, statuses[0] as string))
		else if (statuses.length > 1) conditions.push(inArray(objects.status, statuses))
	}
	if (filter.owner) {
		const owners = filter.owner.split(',').filter((id) => UUID_RE.test(id))
		if (owners.length === 1) conditions.push(eq(objects.owner, owners[0] as string))
		else if (owners.length > 1) conditions.push(inArray(objects.owner, owners))
	}
	if (filter.ids) {
		const idList = filter.ids.split(',').filter((id) => UUID_RE.test(id))
		if (idList.length > 0) conditions.push(inArray(objects.id, idList))
	}
	return conditions
}

/** Cap-aware id resolution for filter-scoped bulk ops.
 *
 * Selects up to MAX_BULK_AFFECTED_ROWS+1 ids in a single round-trip. If the
 * extra row materializes, the predicate matches more rows than the cap allows
 * — the caller short-circuits to 422 without performing any writes. Running
 * the SELECT once (rather than COUNT(*) + SELECT) avoids a TOCTOU window where
 * a fresh insert between the two would let a runaway predicate sneak past the
 * cap. */
async function resolveFilterIdsCapped(
	executor: Database,
	workspaceId: string,
	filter: ObjectsFilter,
): Promise<{ ids: string[]; capExceeded: boolean; matchedCount: number }> {
	const conditions = buildObjectsWhere(workspaceId, filter)
	const rows = await executor
		.select({ id: objects.id })
		.from(objects)
		.where(and(...conditions))
		.limit(MAX_BULK_AFFECTED_ROWS + 1)
	if (rows.length > MAX_BULK_AFFECTED_ROWS) {
		// Real count is worth the round-trip — the client surfaces it back to the
		// user as "5,247 matching filter (over 1,000-row cap)" so they can decide
		// how to narrow the predicate.
		const [totalRow] = await executor
			.select({ value: count() })
			.from(objects)
			.where(and(...conditions))
		return {
			ids: [],
			capExceeded: true,
			matchedCount: totalRow?.value ?? rows.length,
		}
	}
	return { ids: rows.map((r) => r.id), capExceeded: false, matchedCount: rows.length }
}

// POST / - Create object
const createObjectRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Objects'],
	summary: 'Create object',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: createObjectSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: objectResponseSchema } },
			description: 'Object created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace not found',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object with this ID already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

app.openapi(createObjectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	// Fetch workspace to validate status
	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settings = workspace.settings as WorkspaceSettings

	// Validate object type against enabled extensions
	const enabledModules = getEnabledModuleIds(settings as Record<string, unknown>)
	const validTypes = getAllValidTypes(enabledModules, settings)
	if (!validTypes.includes(body.type)) {
		return c.json(createInvalidTypeError(body.type, 'type', validTypes), 400)
	}

	const validStatuses = settings?.statuses?.[body.type]
	if (validStatuses && !validStatuses.includes(body.status)) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				`Invalid status '${body.status}' for type '${body.type}'`,
				[
					{
						field: 'status',
						message: `'${body.status}' is not a valid status for type '${body.type}'`,
						expected: validStatuses.map((s) => `'${s}'`).join(' | '),
						received: `'${body.status}'`,
					},
				],
				`Valid statuses for '${body.type}': ${validStatuses.join(', ')}`,
			),
			400,
		)
	}

	const [created] = await db
		.insert(objects)
		.values({
			...(body.id && { id: body.id }),
			workspaceId,
			type: body.type,
			title: body.title,
			content: body.content,
			status: body.status,
			metadata: body.metadata,
			owner: body.owner,
			createdBy: actorId,
		})
		.onConflictDoNothing({ target: objects.id })
		.returning()

	if (!created) {
		if (body.id) {
			return c.json(createApiError('BAD_REQUEST', 'An object with this ID already exists'), 409)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create object'), 500)
	}

	// Log event
	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: body.type,
		entityId: created.id,
		data: created,
	})

	// Auto-subscribe the creator so they're notified about future comments.
	await autoSubscribe(db, {
		workspaceId,
		actorId,
		entityType: 'object',
		entityId: created.id,
		source: 'author',
	})

	return c.json(serialize(created) as z.infer<typeof objectResponseSchema>, 201)
})

// GET / - List objects
const listObjectsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Objects'],
	summary: 'List objects',
	request: {
		headers: workspaceIdHeader,
		query: objectQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(objectResponseSchema) } },
			description: 'List of objects',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(listObjectsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = buildObjectsWhere(workspaceId, {
		type: query.type,
		status: query.status,
		owner: query.owner,
		ids: query.ids,
	})
	const orderBy = resolveOrderBy(query)

	// Run the page fetch and the total-row count in parallel so the
	// virtualizer can render a stable "showing N of M" without an extra
	// round-trip. The count uses the same predicate as the page so
	// "select all N matching this filter" stays honest.
	const [results, totalRow] = await Promise.all([
		db
			.select()
			.from(objects)
			.where(and(...conditions))
			.limit(query.limit)
			.offset(query.offset)
			.orderBy(...orderBy),
		db
			.select({ value: count() })
			.from(objects)
			.where(and(...conditions)),
	])

	c.header('X-Total-Count', String(totalRow[0]?.value ?? results.length))
	return c.json(serializeArray(results) as z.infer<typeof objectResponseSchema>[], 200)
})

// GET /search - Search objects by text
const searchObjectsRoute = createRoute({
	method: 'get',
	path: '/search',
	tags: ['Objects'],
	summary: 'Search objects by text',
	request: {
		headers: workspaceIdHeader,
		query: searchObjectsSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(objectResponseSchema) } },
			description: 'Search results',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(searchObjectsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')

	const conditions = buildObjectsWhere(workspaceId, {
		q: query.q,
		type: query.type,
		status: query.status,
	})
	const orderBy = resolveOrderBy(query)

	const [results, totalRow] = await Promise.all([
		db
			.select()
			.from(objects)
			.where(and(...conditions))
			.limit(query.limit)
			.offset(query.offset)
			.orderBy(...orderBy),
		db
			.select({ value: count() })
			.from(objects)
			.where(and(...conditions)),
	])

	c.header('X-Total-Count', String(totalRow[0]?.value ?? results.length))
	return c.json(serializeArray(results) as z.infer<typeof objectResponseSchema>[], 200)
})

// GET /{id}/graph - Get object with relationships and connected objects
const getObjectGraphRoute = createRoute({
	method: 'get',
	path: '/{id}/graph',
	tags: ['Objects'],
	summary: 'Get object with relationships and connected objects',
	request: {
		headers: workspaceIdHeader,
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: objectGraphResponseSchema } },
			description: 'Object graph',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found',
		},
	},
})

app.openapi(getObjectGraphRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [object] = await db
		.select()
		.from(objects)
		.where(and(eq(objects.id, id), eq(objects.workspaceId, workspaceId)))
		.limit(1)

	if (!object) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	// Fetch all relationships where this object is source or target
	const rels = await db
		.select()
		.from(relationships)
		.where(or(eq(relationships.sourceId, id), eq(relationships.targetId, id)))

	// Collect connected object IDs — skip endpoints typed as 'file', since
	// those live in the `files` table (resolved into the `files` array below)
	// and would never match against `objects.id`.
	const connectedIds = new Set<string>()
	for (const rel of rels) {
		if (rel.sourceId !== id && rel.sourceType !== 'file') connectedIds.add(rel.sourceId)
		if (rel.targetId !== id && rel.targetType !== 'file') connectedIds.add(rel.targetId)
	}

	// Batch-fetch connected objects
	let connectedObjects: (typeof objects.$inferSelect)[] = []
	if (connectedIds.size > 0) {
		connectedObjects = await db
			.select()
			.from(objects)
			.where(inArray(objects.id, [...connectedIds]))
	}

	// Fetch recent activity + comments for this object. Events use the object's
	// type (task/bet/insight) as entityType for lifecycle events and 'object' for
	// comments — filter on entityId alone (scoped by workspace) to capture both.
	const objectEvents = await db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.entityId, id)))
		.orderBy(desc(events.id))
		.limit(100)

	// Resolve actor names referenced by owner-change clauses (formatter only
	// needs them for `data.previous.owner` / `data.updated.owner`).
	const referencedActorIds = new Set<string>()
	for (const event of objectEvents) {
		const data = event.data as {
			previous?: { owner?: unknown }
			updated?: { owner?: unknown }
		} | null
		const prevOwner = data?.previous?.owner
		const nextOwner = data?.updated?.owner
		if (typeof prevOwner === 'string') referencedActorIds.add(prevOwner)
		if (typeof nextOwner === 'string') referencedActorIds.add(nextOwner)
	}

	const actorsById = new Map<string, ActorRef>()
	if (referencedActorIds.size > 0) {
		const rows = await db
			.select({ id: actors.id, name: actors.name })
			.from(actors)
			.where(inArray(actors.id, [...referencedActorIds]))
		for (const row of rows) actorsById.set(row.id, row)
	}

	const serializedEvents = objectEvents.map((event) => ({
		...serialize(event),
		description: formatEventDescription(event, { actorsById }),
	}))

	const [subscribed, unreadCount, subscriberCount] = await Promise.all([
		isSubscribed(db, { actorId, entityType: 'object', entityId: id }),
		getUnreadCount(db, { workspaceId, actorId, entityType: 'object', entityId: id }),
		getSubscriberCount(db, { workspaceId, entityType: 'object', entityId: id }),
	])

	// Build a title lookup keyed by object id so each relationship can carry the
	// titles of its endpoints. Agents reading this payload should reference
	// connected objects by title in human-facing output, not by UUID.
	const titleById = new Map<string, string | null>()
	titleById.set(object.id, object.title ?? null)
	for (const co of connectedObjects) titleById.set(co.id, co.title ?? null)

	// Collect every file id this object touches: (1) files attached via
	// `attached` relationships (sourceType/targetType === 'file'), (2) files
	// referenced by `data.attachmentFileIds` on comment events. Resolving them
	// here saves agents an N+1 fan-out of /api/files/:id calls.
	const fileIds = new Set<string>()
	for (const r of rels) {
		if (r.sourceType === 'file') fileIds.add(r.sourceId)
		if (r.targetType === 'file') fileIds.add(r.targetId)
	}
	for (const event of objectEvents) {
		if (event.action !== 'commented') continue
		const data = event.data as { attachmentFileIds?: unknown } | null
		const ids = data?.attachmentFileIds
		if (!Array.isArray(ids)) continue
		// `event.data` is JSONB and only validated by the writer that produced
		// it. Skip anything that isn't a UUID so a stray string can't crash the
		// inArray query below with `invalid input syntax for type uuid`.
		for (const id of ids) {
			if (typeof id === 'string' && UUID_RE.test(id)) fileIds.add(id)
		}
	}

	let filesSummary: Array<{
		id: string
		name: string
		mimeType: string
		sizeBytes: number
		url: string
	}> = []
	if (fileIds.size > 0) {
		// Skip file resolution rather than 500 the whole graph when FRONTEND_URL
		// is missing in prod — the rest of the payload is still useful.
		let frontendUrl: string | null = null
		try {
			frontendUrl = frontendBaseUrl()
		} catch (err) {
			logger.error('Cannot mint file URLs for object graph', { error: String(err) })
		}
		if (frontendUrl) {
			const rows = await db
				.select({
					id: files.id,
					name: files.name,
					mimeType: files.mimeType,
					sizeBytes: files.sizeBytes,
				})
				.from(files)
				.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, [...fileIds])))
			filesSummary = rows.map((row) => ({
				...row,
				url: fileViewerUrl(frontendUrl as string, workspaceId, row.id),
			}))
		}
	}

	return c.json(
		{
			object: {
				...serialize(object),
				is_subscribed: subscribed,
				unread_count: unreadCount,
				subscriber_count: subscriberCount,
			},
			relationships: rels.map((r) => ({
				...serialize(r),
				sourceTitle: titleById.get(r.sourceId) ?? null,
				targetTitle: titleById.get(r.targetId) ?? null,
			})),
			connected_objects: serializeArray(connectedObjects),
			events: serializedEvents,
			files: filesSummary,
		} as z.infer<typeof objectGraphResponseSchema>,
		200,
	)
})

// GET /{id} - Get object by ID
const getObjectRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Objects'],
	summary: 'Get object by ID',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: objectResponseSchema } },
			description: 'Object found',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found',
		},
	},
})

app.openapi(getObjectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [object] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!object || !(await isWorkspaceMember(db, actorId, object.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	const [subscribed, unreadCount, subscriberCount] = await Promise.all([
		isSubscribed(db, { actorId, entityType: 'object', entityId: id }),
		getUnreadCount(db, {
			workspaceId: object.workspaceId,
			actorId,
			entityType: 'object',
			entityId: id,
		}),
		getSubscriberCount(db, {
			workspaceId: object.workspaceId,
			entityType: 'object',
			entityId: id,
		}),
	])

	return c.json(
		{
			...serialize(object),
			is_subscribed: subscribed,
			unread_count: unreadCount,
			subscriber_count: subscriberCount,
		} as z.infer<typeof objectResponseSchema>,
		200,
	)
})

// PATCH /{id} - Update object
const updateObjectRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['Objects'],
	summary: 'Update object',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateObjectSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: objectResponseSchema } },
			description: 'Object updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found',
		},
	},
})

app.openapi(updateObjectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	// Get existing object for workspace context
	const [existing] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	// If status is being updated, validate against workspace settings
	if (body.status) {
		const [workspace] = await db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, existing.workspaceId))
			.limit(1)

		if (workspace) {
			const settings = workspace.settings as WorkspaceSettings
			const validStatuses = settings?.statuses?.[existing.type]
			if (validStatuses && !validStatuses.includes(body.status)) {
				return c.json(
					createApiError(
						'BAD_REQUEST',
						`Invalid status '${body.status}' for type '${existing.type}'`,
						[
							{
								field: 'status',
								message: `'${body.status}' is not a valid status for type '${existing.type}'`,
								expected: validStatuses.map((s) => `'${s}'`).join(' | '),
								received: `'${body.status}'`,
							},
						],
						`Valid statuses for '${existing.type}': ${validStatuses.join(', ')}`,
					),
					400,
				)
			}
		}
	}

	const updateData = {
		...body,
		updatedAt: new Date(),
	}

	// Shallow-merge metadata: new fields are added/overwritten, existing fields are preserved
	if (body.metadata && existing.metadata) {
		updateData.metadata = {
			...(existing.metadata as typeof body.metadata),
			...body.metadata,
		}
	}

	const [updated] = await db.update(objects).set(updateData).where(eq(objects.id, id)).returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	// Log event
	const action = body.status && body.status !== existing.status ? 'status_changed' : 'updated'
	await db.insert(events).values({
		workspaceId: existing.workspaceId,
		actorId,
		action,
		entityType: existing.type,
		entityId: id,
		data: { previous: existing, updated },
	})

	return c.json(serialize(updated) as z.infer<typeof objectResponseSchema>, 200)
})

// DELETE /{id} - Delete object
const deleteObjectRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['Objects'],
	summary: 'Delete object',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Object deleted',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Object not found',
		},
	},
})

// POST /migrate-type - Bulk migrate or delete every object of a given type
const migrateObjectTypeRoute = createRoute({
	method: 'post',
	path: '/migrate-type',
	tags: ['Objects'],
	summary: 'Migrate or delete all objects of a given type in a workspace',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: migrateObjectTypeSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: migrateObjectTypeResponseSchema } },
			description: 'Migration completed',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace not found',
		},
	},
})

app.openapi(migrateObjectTypeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const settings = workspace.settings as WorkspaceSettings

	if (body.mode === 'migrate') {
		// At this point Zod refine guarantees toType is defined; assert for TS narrowing.
		const toType = body.toType as string
		const enabledModules = getEnabledModuleIds(settings as Record<string, unknown>)
		const validTypes = getAllValidTypes(enabledModules, settings)
		if (!validTypes.includes(toType)) {
			return c.json(createInvalidTypeError(toType, 'toType', validTypes), 400)
		}

		const targetStatuses = settings?.statuses?.[toType] ?? []
		const fallbackStatus = targetStatuses[0]
		if (!fallbackStatus) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					`Target type '${toType}' has no statuses configured`,
					undefined,
					'Configure at least one status for the target type before migrating.',
				),
				400,
			)
		}

		// Pull every object of fromType so we can compute per-row status mapping.
		const rows = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, body.fromType)))

		if (rows.length === 0) {
			return c.json({ mode: 'migrate' as const, fromType: body.fromType, toType, count: 0 }, 200)
		}

		// Group rows by their resolved target status so we can emit one UPDATE per
		// group instead of one per row — keeps the transaction short on large
		// workspaces. Map preserves insertion order, so groups appear in the order
		// statuses are first encountered while iterating rows.
		const statusMap = body.statusMap ?? {}
		const idsByStatus = new Map<string, string[]>()
		const eventValues: (typeof events.$inferInsert)[] = []
		for (const row of rows) {
			const mappedStatus = statusMap[row.status] ?? row.status
			const newStatus = targetStatuses.includes(mappedStatus) ? mappedStatus : fallbackStatus
			const bucket = idsByStatus.get(newStatus)
			if (bucket) bucket.push(row.id)
			else idsByStatus.set(newStatus, [row.id])
			eventValues.push({
				workspaceId,
				actorId,
				action: 'type_migrated',
				entityType: toType,
				entityId: row.id,
				data: { fromType: body.fromType, toType, fromStatus: row.status, toStatus: newStatus },
			})
		}

		const now = new Date()
		await db.transaction(async (tx) => {
			for (const [newStatus, ids] of idsByStatus) {
				await tx
					.update(objects)
					.set({ type: toType, status: newStatus, updatedAt: now })
					.where(inArray(objects.id, ids))
			}
			await tx.insert(events).values(eventValues)
		})

		return c.json(
			{ mode: 'migrate' as const, fromType: body.fromType, toType, count: rows.length },
			200,
		)
	}

	// mode === 'delete'
	const toDelete = await db
		.select({ id: objects.id })
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, body.fromType)))

	if (toDelete.length === 0) {
		return c.json({ mode: 'delete' as const, fromType: body.fromType, count: 0 }, 200)
	}

	const deletedIds = toDelete.map(({ id }) => id)

	await db.transaction(async (tx) => {
		// Clean up polymorphic subscription + read_state rows before the
		// objects vanish — there is no FK because (entity_type, entity_id)
		// is polymorphic, so cascade can't do this for us.
		await tx
			.delete(subscriptions)
			.where(
				and(eq(subscriptions.entityType, 'object'), inArray(subscriptions.entityId, deletedIds)),
			)
		await tx
			.delete(readState)
			.where(and(eq(readState.entityType, 'object'), inArray(readState.entityId, deletedIds)))

		await tx
			.delete(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, body.fromType)))

		await tx.insert(events).values(
			toDelete.map(({ id: objectId }) => ({
				workspaceId,
				actorId,
				action: 'deleted' as const,
				entityType: body.fromType,
				entityId: objectId,
				data: { reason: 'extension_removed' },
			})),
		)
	})

	return c.json({ mode: 'delete' as const, fromType: body.fromType, count: toDelete.length }, 200)
})

// POST /bulk-update - Update many objects in one call with per-id partial failure
const bulkUpdateObjectsRoute = createRoute({
	method: 'post',
	path: '/bulk-update',
	tags: ['Objects'],
	summary: 'Bulk update objects',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: bulkUpdateObjectsSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: bulkUpdateObjectsResponseSchema } },
			description: 'Bulk update completed (per-id results, including failures)',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(bulkUpdateObjectsRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')
	const { patch } = body

	// Resolve the working id set per scope. Filter scope is capped server-side
	// so a runaway predicate can't take down the workspace; if the cap is
	// exceeded we return 422 without performing any writes — the client uses
	// `count` + `max` to tell the user how many rows the predicate matched.
	let uniqueIds: string[]
	if (body.scope === 'filter') {
		const resolved = await resolveFilterIdsCapped(db, workspaceId, body.filter)
		if (resolved.capExceeded) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					`Bulk update would touch ${resolved.matchedCount} rows, over the ${MAX_BULK_AFFECTED_ROWS}-row cap`,
					[
						{
							field: '_root',
							message: 'cap_exceeded',
							expected: String(MAX_BULK_AFFECTED_ROWS),
							received: String(resolved.matchedCount),
						},
					],
					'Narrow the filter or operate on fewer rows.',
				),
				400,
			)
		}
		uniqueIds = resolved.ids
	} else {
		// Dedup so duplicates in the request don't double-write or double-report.
		uniqueIds = Array.from(new Set(body.ids))
	}

	// Filter scope can legitimately match zero rows (e.g. the predicate's last
	// row was just deleted) — return an empty results array rather than 400.
	if (uniqueIds.length === 0) {
		logger.info('bulk-update objects', {
			actorId,
			scope: body.scope,
			requested: 0,
			deduped: 0,
			updated: 0,
			failed: 0,
		})
		return c.json({ results: [] }, 200)
	}

	// Scope the fetch to the header workspace — ids that don't belong here
	// collapse into "Object not found" without revealing whether they exist
	// elsewhere. authMiddleware has already verified the caller is a member
	// of this workspace, so no inline membership check is needed.
	const existingRows = await db
		.select()
		.from(objects)
		.where(and(inArray(objects.id, uniqueIds), eq(objects.workspaceId, workspaceId)))
	const existingById = new Map(existingRows.map((row) => [row.id, row]))

	let workspaceSettings: WorkspaceSettings | undefined
	if (patch.status !== undefined && existingRows.length > 0) {
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		workspaceSettings = ws?.settings as WorkspaceSettings | undefined
	}

	type ResultEntry = { id: string; ok: boolean; error?: string }
	type Plan = {
		id: string
		previous: (typeof existingRows)[number]
		updateData: Partial<typeof objects.$inferInsert>
		action: 'updated' | 'status_changed'
		resultEntry: ResultEntry
	}
	const plans: Plan[] = []
	const results: ResultEntry[] = []
	const now = new Date()

	for (const id of uniqueIds) {
		const existing = existingById.get(id)
		if (!existing) {
			results.push({ id, ok: false, error: 'Object not found' })
			continue
		}

		if (patch.status !== undefined) {
			const validStatuses = workspaceSettings?.statuses?.[existing.type]
			if (validStatuses && !validStatuses.includes(patch.status)) {
				results.push({
					id,
					ok: false,
					error: `Invalid status '${patch.status}' for type '${existing.type}'`,
				})
				continue
			}
		}

		const updateData: Partial<typeof objects.$inferInsert> = { updatedAt: now }
		if (patch.status !== undefined) updateData.status = patch.status
		if (patch.owner !== undefined) updateData.owner = patch.owner
		if (patch.metadata !== undefined) {
			updateData.metadata = existing.metadata
				? { ...(existing.metadata as Record<string, unknown>), ...patch.metadata }
				: patch.metadata
		}

		const resultEntry: ResultEntry = { id, ok: true }
		plans.push({
			id,
			previous: existing,
			updateData,
			action:
				patch.status !== undefined && patch.status !== existing.status
					? 'status_changed'
					: 'updated',
			resultEntry,
		})
		results.push(resultEntry)
	}

	if (plans.length > 0) {
		await db.transaction(async (tx) => {
			for (const plan of plans) {
				// Re-scope the UPDATE to the planned workspace so a row that moved
				// workspaces between the SELECT and here doesn't get touched.
				const [updated] = await tx
					.update(objects)
					.set(plan.updateData)
					.where(and(eq(objects.id, plan.id), eq(objects.workspaceId, plan.previous.workspaceId)))
					.returning()
				// The row was deleted (or moved out of the workspace) between the
				// initial SELECT and this UPDATE — flip the result to a failure and
				// skip the event so we don't log a no-op.
				if (!updated) {
					plan.resultEntry.ok = false
					plan.resultEntry.error = 'Object not found'
					continue
				}
				await tx.insert(events).values({
					workspaceId: plan.previous.workspaceId,
					actorId,
					action: plan.action,
					entityType: plan.previous.type,
					entityId: plan.id,
					data: { previous: plan.previous, updated },
				})
			}
		})
	}

	const okCount = results.filter((r) => r.ok).length
	logger.info('bulk-update objects', {
		actorId,
		scope: body.scope,
		requested: body.scope === 'ids' ? body.ids.length : uniqueIds.length,
		deduped: uniqueIds.length,
		updated: okCount,
		failed: uniqueIds.length - okCount,
	})

	return c.json({ results }, 200)
})

// POST /bulk-delete - Delete many objects in one call with per-id partial failure.
// Mirrors bulk-update so the client can treat the per-id result envelope the
// same for both ops. Filter scope hits the same MAX_BULK_AFFECTED_ROWS ceiling
// so a runaway predicate can't take down the workspace.
const bulkDeleteObjectsRoute = createRoute({
	method: 'post',
	path: '/bulk-delete',
	tags: ['Objects'],
	summary: 'Bulk delete objects',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: bulkDeleteObjectsSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: bulkUpdateObjectsResponseSchema } },
			description: 'Bulk delete completed (per-id results, including failures)',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request (including cap_exceeded for filter scope)',
		},
	},
})

app.openapi(bulkDeleteObjectsRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	let uniqueIds: string[]
	if (body.scope === 'filter') {
		const resolved = await resolveFilterIdsCapped(db, workspaceId, body.filter)
		if (resolved.capExceeded) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					`Bulk delete would touch ${resolved.matchedCount} rows, over the ${MAX_BULK_AFFECTED_ROWS}-row cap`,
					[
						{
							field: '_root',
							message: 'cap_exceeded',
							expected: String(MAX_BULK_AFFECTED_ROWS),
							received: String(resolved.matchedCount),
						},
					],
					'Narrow the filter or operate on fewer rows.',
				),
				400,
			)
		}
		uniqueIds = resolved.ids
	} else {
		uniqueIds = Array.from(new Set(body.ids))
	}

	if (uniqueIds.length === 0) {
		logger.info('bulk-delete objects', {
			actorId,
			scope: body.scope,
			requested: 0,
			deduped: 0,
			deleted: 0,
			failed: 0,
		})
		return c.json({ results: [] }, 200)
	}

	// Scope the SELECT to the header workspace — ids outside it collapse into
	// "Object not found" so we don't leak existence of out-of-scope rows.
	const existingRows = await db
		.select()
		.from(objects)
		.where(and(inArray(objects.id, uniqueIds), eq(objects.workspaceId, workspaceId)))
	const existingById = new Map(existingRows.map((row) => [row.id, row]))

	type ResultEntry = { id: string; ok: boolean; error?: string }
	const results: ResultEntry[] = []
	const toDelete: typeof existingRows = []
	for (const id of uniqueIds) {
		const existing = existingById.get(id)
		if (!existing) {
			results.push({ id, ok: false, error: 'Object not found' })
			continue
		}
		toDelete.push(existing)
		results.push({ id, ok: true })
	}

	if (toDelete.length > 0) {
		const deletedIds = toDelete.map((row) => row.id)
		await db.transaction(async (tx) => {
			// Polymorphic subscription + read_state rows aren't FK'd to objects,
			// so drop them explicitly to avoid orphans pointing at a freed
			// entity_id. Same pattern as the single-object DELETE handler.
			await tx
				.delete(subscriptions)
				.where(
					and(eq(subscriptions.entityType, 'object'), inArray(subscriptions.entityId, deletedIds)),
				)
			await tx
				.delete(readState)
				.where(and(eq(readState.entityType, 'object'), inArray(readState.entityId, deletedIds)))

			// Re-scope the DELETE to the header workspace so a row that moved
			// workspaces between the SELECT and here doesn't get touched.
			await tx
				.delete(objects)
				.where(and(inArray(objects.id, deletedIds), eq(objects.workspaceId, workspaceId)))

			await tx.insert(events).values(
				toDelete.map((row) => ({
					workspaceId: row.workspaceId,
					actorId,
					action: 'deleted' as const,
					entityType: row.type,
					entityId: row.id,
					data: row,
				})),
			)
		})
	}

	const okCount = results.filter((r) => r.ok).length
	logger.info('bulk-delete objects', {
		actorId,
		scope: body.scope,
		requested: body.scope === 'ids' ? body.ids.length : uniqueIds.length,
		deduped: uniqueIds.length,
		deleted: okCount,
		failed: uniqueIds.length - okCount,
	})

	return c.json({ results }, 200)
})

app.openapi(deleteObjectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [existing] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	await db.transaction(async (tx) => {
		// Polymorphic subscription + read_state rows aren't FK'd to objects, so
		// drop them explicitly to avoid orphans pointing at a freed entity_id.
		await tx
			.delete(subscriptions)
			.where(and(eq(subscriptions.entityType, 'object'), eq(subscriptions.entityId, id)))
		await tx
			.delete(readState)
			.where(and(eq(readState.entityType, 'object'), eq(readState.entityId, id)))

		await tx.delete(objects).where(eq(objects.id, id))

		await tx.insert(events).values({
			workspaceId: existing.workspaceId,
			actorId,
			action: 'deleted',
			entityType: existing.type,
			entityId: id,
			data: existing,
		})
	})

	return c.json({ deleted: true as const }, 200)
})

export default app
