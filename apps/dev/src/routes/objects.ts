import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	files,
	objects,
	readState,
	relationships,
	sessions,
	subscriptions,
	workspaces,
} from '@maskin/db/schema'
import { getAllValidTypes, getEnabledModuleIds } from '@maskin/module-sdk'
import {
	type ActorRef,
	OBJECT_DIFF_FIELDS,
	TERMINAL_BET_STATUSES,
	boardObjectQuerySchema,
	boardObjectResponseSchema,
	bulkUpdateObjectsResponseSchema,
	bulkUpdateObjectsSchema,
	computeChanges,
	createObjectSchema,
	findChange,
	formatEventDescription,
	getChangesFromEventData,
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
	gt,
	ilike,
	inArray,
	lt,
	ne,
	or,
	sql,
} from 'drizzle-orm'
import { createApiError, createInvalidTypeError } from '../lib/errors'
import { fileViewerUrl, frontendBaseUrl } from '../lib/file-urls'
import { logger } from '../lib/logger'
import { insertNotificationsWithEvents } from '../lib/notifications'
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

// Only alphanumeric + underscore field names are safe to inline via sql.raw
// (sort, groupBy, and metadata filter keys all key off this same check).
const SAFE_METADATA_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

// Keep in sync with KNOWN_SORT_COLUMNS in packages/shared/src/schemas/objects.ts
const sortColumns: Record<string, Column | SQL> = {
	createdAt: objects.createdAt,
	updatedAt: objects.updatedAt,
	title: objects.title,
	status: objects.status,
	type: objects.type,
	driver: objects.driver,
	createdBy: objects.createdBy,
	boardOrder: sql`coalesce((${objects.metadata}->>'board_order')::numeric, 2147483647)`,
}

/** Resolve sort expression — built-in column or metadata->>'field_name'. Returns null for unknown/unsafe fields. */
function resolveSortColumn(sortField: string): Column | SQL | null {
	if (sortColumns[sortField]) return sortColumns[sortField]
	if (sortField.startsWith('metadata.')) {
		const fieldName = sortField.slice(9)
		if (!SAFE_METADATA_FIELD_NAME_RE.test(fieldName)) return null
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
 * Parses `metadata.<fieldName>=<value>` query keys into filter conditions
 * `metadata->>'<fieldName>' = '<value>'` (plain text equality). Field names
 * are workspace-defined custom properties (see `create_workspace_field`) so
 * they can't be enumerated ahead of time — validated per-key against
 * `SAFE_METADATA_FIELD_NAME_RE` instead, since they're inlined via `sql.raw`.
 *
 * Returns the first invalid field name found (caller should 400), or the
 * parsed list of filters otherwise.
 */
function extractMetadataFilters(
	rawQuery: Record<string, string | string[] | undefined>,
): { ok: true; filters: { field: string; value: string }[] } | { ok: false; invalidField: string } {
	const filters: { field: string; value: string }[] = []
	for (const [key, rawValue] of Object.entries(rawQuery)) {
		if (!key.startsWith('metadata.')) continue
		const field = key.slice('metadata.'.length)
		const value = Array.isArray(rawValue) ? rawValue[0] : rawValue
		if (!SAFE_METADATA_FIELD_NAME_RE.test(field)) return { ok: false, invalidField: field }
		if (typeof value === 'string' && value.length > 0) filters.push({ field, value })
	}
	return { ok: true, filters }
}

function invalidMetadataFieldError(fieldName: string) {
	return createApiError('BAD_REQUEST', `Invalid metadata filter field name: '${fieldName}'`, [
		{
			field: `metadata.${fieldName}`,
			message:
				'Field names must start with a letter and contain only letters, numbers, and underscores.',
		},
	])
}

function buildObjectListConditions(
	query: {
		type?: string
		status?: string
		driver?: string
		ids?: string
		q?: string
		updated_before?: string
		updated_after?: string
	},
	metadataFilters: { field: string; value: string }[] = [],
) {
	const conditions: SQL[] = []
	if (query.type) conditions.push(eq(objects.type, query.type))
	if (query.status) {
		const statuses = query.status.split(',').filter(Boolean)
		if (statuses.length === 1) conditions.push(eq(objects.status, statuses[0] as string))
		else if (statuses.length > 1) conditions.push(inArray(objects.status, statuses))
	}
	if (query.driver) {
		const owners = query.driver.split(',').filter((id) => UUID_RE.test(id))
		if (owners.length === 1) conditions.push(eq(objects.driver, owners[0] as string))
		else if (owners.length > 1) conditions.push(inArray(objects.driver, owners))
	}
	if (query.ids) {
		const idList = query.ids.split(',').filter((id) => UUID_RE.test(id))
		if (idList.length > 0) conditions.push(inArray(objects.id, idList))
	}
	if (query.q) {
		const escaped = query.q.replace(/[%_\\]/g, '\\$&')
		const pattern = `%${escaped}%`
		const textMatch = or(ilike(objects.title, pattern), ilike(objects.content, pattern))
		if (textMatch) conditions.push(textMatch)
	}
	// Half-open contract — Zod has already validated these as ISO-8601 strings.
	if (query.updated_before) conditions.push(lt(objects.updatedAt, new Date(query.updated_before)))
	if (query.updated_after) conditions.push(gt(objects.updatedAt, new Date(query.updated_after)))
	// Field name pre-validated by extractMetadataFilters; value is parameter-bound.
	for (const { field, value } of metadataFilters) {
		conditions.push(sql`${objects.metadata}->>'${sql.raw(field)}' = ${value}`)
	}
	return conditions
}

function resolveBoardGroupExpression(groupBy?: string): SQL {
	if (!groupBy || groupBy === 'status') return sql`${objects.status}`
	if (groupBy === 'driver') return sql`coalesce(${objects.driver}::text, '')`
	if (groupBy === 'createdBy') return sql`coalesce(${objects.createdBy}::text, '')`
	if (groupBy === 'type') return sql`${objects.type}`
	if (groupBy.startsWith('metadata.')) {
		const fieldName = groupBy.slice('metadata.'.length)
		if (SAFE_METADATA_FIELD_NAME_RE.test(fieldName)) {
			return sql`coalesce(${objects.metadata}->>'${sql.raw(fieldName)}', '')`
		}
	}
	return sql`${objects.status}`
}

function columnLabel(groupBy: string | undefined, value: string) {
	if (!value) return 'No value'
	if (!groupBy || groupBy === 'status') return value
	return value
}

function toCount(value: unknown) {
	if (typeof value === 'number') return value
	if (typeof value === 'string') return Number.parseInt(value, 10) || 0
	return 0
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
			driver: body.driver,
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

	const parsedMetadataFilters = extractMetadataFilters(c.req.query())
	if (!parsedMetadataFilters.ok) {
		return c.json(invalidMetadataFieldError(parsedMetadataFilters.invalidField), 400)
	}

	const conditions = [
		eq(objects.workspaceId, workspaceId),
		...buildObjectListConditions(query, parsedMetadataFilters.filters),
	]

	const orderBy = resolveOrderBy(query)

	const results = await db
		.select()
		.from(objects)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(...orderBy)

	return c.json(serializeArray(results) as z.infer<typeof objectResponseSchema>[], 200)
})

// GET /board - List board columns with per-column pagination
const boardObjectsRoute = createRoute({
	method: 'get',
	path: '/board',
	tags: ['Objects'],
	summary: 'List board columns',
	request: {
		headers: workspaceIdHeader,
		query: boardObjectQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: boardObjectResponseSchema } },
			description: 'Board columns with paged objects and totals',
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

app.openapi(boardObjectsRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const rawQuery = c.req.query()
	const query = c.req.valid('query') ?? {
		...rawQuery,
		sort: rawQuery.sort ?? 'createdAt',
		order: rawQuery.order === 'asc' ? 'asc' : 'desc',
		limit: rawQuery.limit ? Number.parseInt(rawQuery.limit, 10) : 20,
		offset: rawQuery.offset ? Number.parseInt(rawQuery.offset, 10) : 0,
	}
	const groupBy = query.groupBy
	const groupExpr = resolveBoardGroupExpression(groupBy)
	const orderBy = resolveOrderBy(query)

	const [workspace] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const parsedMetadataFilters = extractMetadataFilters(rawQuery)
	if (!parsedMetadataFilters.ok) {
		return c.json(invalidMetadataFieldError(parsedMetadataFilters.invalidField), 400)
	}

	const baseConditions = [
		eq(objects.workspaceId, workspaceId),
		...buildObjectListConditions(
			{
				type: query.type,
				status: query.status,
				driver: query.driver,
				ids: query.ids,
				q: query.q,
				updated_before: query.updated_before,
				updated_after: query.updated_after,
			},
			parsedMetadataFilters.filters,
		),
	]

	const countRows = await db
		.select({ value: groupExpr, total: count() })
		.from(objects)
		.where(and(...baseConditions))
		.groupBy(groupExpr)

	const totals = new Map<string, number>()
	for (const row of countRows as Array<{ value: unknown; total: unknown }>) {
		totals.set(String(row.value ?? ''), toCount(row.total))
	}

	let columnValues: string[]
	if (!groupBy || groupBy === 'status') {
		const settings = workspace.settings as WorkspaceSettings
		const configured = settings?.statuses?.[query.type] ?? []
		const requested = query.status ? new Set(query.status.split(',').filter(Boolean)) : null
		columnValues = configured.filter((status) => !requested || requested.has(status))
		for (const value of totals.keys()) {
			if (!columnValues.includes(value)) columnValues.push(value)
		}
	} else {
		columnValues = [...totals.keys()].sort((a, b) =>
			columnLabel(groupBy, a).localeCompare(columnLabel(groupBy, b), undefined, {
				numeric: true,
				sensitivity: 'base',
			}),
		)
	}

	if (query.column !== undefined) {
		columnValues = columnValues.filter((value) => value === query.column)
	}

	const columns = []
	for (const value of columnValues) {
		const columnConditions = [...baseConditions, eq(groupExpr, value)]
		const rows = await db
			.select()
			.from(objects)
			.where(and(...columnConditions))
			.limit(query.limit)
			.offset(query.offset)
			.orderBy(...orderBy)

		columns.push({
			id: `${groupBy ?? 'status'}:${value || 'none'}`,
			label: columnLabel(groupBy, value),
			value,
			total: totals.get(value) ?? 0,
			objects: serializeArray(rows),
		})
	}

	return c.json({ columns } as z.infer<typeof boardObjectResponseSchema>, 200)
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

	const parsedMetadataFilters = extractMetadataFilters(c.req.query())
	if (!parsedMetadataFilters.ok) {
		return c.json(invalidMetadataFieldError(parsedMetadataFilters.invalidField), 400)
	}

	const conditions = [
		eq(objects.workspaceId, workspaceId),
		...buildObjectListConditions(query, parsedMetadataFilters.filters),
	]

	const orderBy = resolveOrderBy(query)

	const results = await db
		.select()
		.from(objects)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(...orderBy)

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

	// Resolve endpoints by object/file id, not by the stored `sourceType`/
	// `targetType` label. Some legacy edges were written with a specialised
	// label (`'insight'`, `'bet'`, ...) or a mismatched label, so filtering
	// on the label silently drops valid edges. Instead we take every non-self
	// endpoint id from `rels`, look up which of those live in `files` in one
	// query, and treat the rest as object endpoints.
	const endpointIds = new Set<string>()
	for (const rel of rels) {
		if (rel.sourceId !== id) endpointIds.add(rel.sourceId)
		if (rel.targetId !== id) endpointIds.add(rel.targetId)
	}

	const attachedFileIds = new Set<string>()
	if (endpointIds.size > 0) {
		const fileRows = await db
			.select({ id: files.id })
			.from(files)
			.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, [...endpointIds])))
		for (const row of fileRows) attachedFileIds.add(row.id)
	}

	const connectedIds = new Set<string>()
	for (const endpointId of endpointIds) {
		if (!attachedFileIds.has(endpointId)) connectedIds.add(endpointId)
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

	// Resolve actor names referenced by driver-change clauses. Handles both the
	// new `{changes: [{field: 'driver', old, new}]}` shape and the legacy
	// `{previous, updated}` snapshot shape for historical rows.
	const referencedActorIds = new Set<string>()
	for (const event of objectEvents) {
		if (event.action !== 'updated' && event.action !== 'status_changed') continue
		const changes = getChangesFromEventData(event.data, OBJECT_DIFF_FIELDS)
		const driverChange = findChange(changes, 'driver')
		if (!driverChange) continue
		if (typeof driverChange.old === 'string') referencedActorIds.add(driverChange.old)
		if (typeof driverChange.new === 'string') referencedActorIds.add(driverChange.new)
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

	const [subscribed, unreadCount, subscriberCount, activeSession] = await Promise.all([
		isSubscribed(db, { actorId, entityType: 'object', entityId: id }),
		getUnreadCount(db, { workspaceId, actorId, entityType: 'object', entityId: id }),
		getSubscriberCount(db, { workspaceId, entityType: 'object', entityId: id }),
		object.activeSessionId
			? db
					.select({ currentActivity: sessions.currentActivity })
					.from(sessions)
					.where(eq(sessions.id, object.activeSessionId))
					.limit(1)
					.then((rows) => rows[0] ?? null)
			: Promise.resolve(null),
	])

	// Build a title lookup keyed by object id so each relationship can carry the
	// titles of its endpoints. Agents reading this payload should reference
	// connected objects by title in human-facing output, not by UUID.
	const titleById = new Map<string, string | null>()
	titleById.set(object.id, object.title ?? null)
	for (const co of connectedObjects) titleById.set(co.id, co.title ?? null)

	// Collect every file id this object touches: (1) files attached via
	// relationships whose endpoint resolves to a row in `files` (already
	// resolved above into `attachedFileIds`), (2) files referenced by
	// `data.attachmentFileIds` on comment events. Resolving them here saves
	// agents an N+1 fan-out of /api/files/:id calls.
	const fileIds = new Set<string>(attachedFileIds)
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
				activeSessionCurrentActivity: activeSession?.currentActivity ?? null,
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

	const [subscribed, unreadCount, subscriberCount, activeSession] = await Promise.all([
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
		object.activeSessionId
			? db
					.select({ currentActivity: sessions.currentActivity })
					.from(sessions)
					.where(eq(sessions.id, object.activeSessionId))
					.limit(1)
					.then((rows) => rows[0] ?? null)
			: Promise.resolve(null),
	])

	return c.json(
		{
			...serialize(object),
			activeSessionCurrentActivity: activeSession?.currentActivity ?? null,
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

	// All three writes (object update, status event, notification fan-out) run in
	// one transaction so a fan-out failure cannot leave the bet updated but
	// watchers un-notified.
	let updated: typeof objects.$inferSelect | undefined

	await db.transaction(async (tx) => {
		// Re-read the row under FOR UPDATE *inside* the transaction rather than
		// trusting the pre-transaction `existing` fetch above. `existing` is only
		// safe to use for the 404/validation checks that already returned by this
		// point — using it here would be a stale read: two concurrent PATCHes that
		// both flip the same bet to a terminal status would both see the same
		// pre-transition `existing.status` and both fan out duplicate
		// notifications. The row lock makes the second PATCH block until the
		// first commits, then observe the now-terminal status and correctly skip
		// the fan-out.
		const [current] = await tx
			.select()
			.from(objects)
			.where(eq(objects.id, id))
			.for('update')
			.limit(1)
		if (!current) return // object deleted concurrently; 404 handled below

		const [row] = await tx.update(objects).set(updateData).where(eq(objects.id, id)).returning()
		if (!row) return

		updated = row

		// Derive action inside the transaction from the locked pre-update read so
		// the event record is accurate even under concurrent PATCHes.
		const action = current.status !== row.status ? 'status_changed' : 'updated'

		// Log a per-field diff instead of full pre/post snapshots. On a 100 KB-content
		// bet, a title-only edit now ships ~200 B of event payload instead of ~200 KB —
		// see bet/mcp-response-shape AC #4.
		const changes = computeChanges(
			current as unknown as Record<string, unknown>,
			row as unknown as Record<string, unknown>,
			OBJECT_DIFF_FIELDS,
		)
		await tx.insert(events).values({
			workspaceId: current.workspaceId,
			actorId,
			action,
			entityType: current.type,
			entityId: id,
			data: { changes },
		})

		// Fan out a notification row to every subscriber when a bet reaches a
		// terminal state (succeeded/failed/paused — see TERMINAL_BET_STATUSES).
		// The status_changed event itself surfaces the entity in the unread feed
		// (see subscriptions.ts); the notification row drives the dedicated
		// terminal-signal UI and is the canonical record for "watcher was told
		// the bet ended". Author/manual/commenter/mentioned subscribers are all
		// included; the actor making the change is excluded (you don't notify
		// yourself about your own flip).
		//
		// Guard on current.status not already being terminal: prevents a re-PATCH
		// of an already-terminal bet from double-notifying subscribers.
		if (
			action === 'status_changed' &&
			current.type === 'bet' &&
			isTerminalBetStatus(row.status) &&
			!isTerminalBetStatus(current.status)
		) {
			await fanOutBetTerminalNotifications(tx, {
				workspaceId: current.workspaceId,
				actorId,
				bet: row,
			})
		}
	})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	return c.json(serialize(updated) as z.infer<typeof objectResponseSchema>, 200)
})

function isTerminalBetStatus(status: string): boolean {
	return (TERMINAL_BET_STATUSES as readonly string[]).includes(status)
}

function betTerminalNotificationContent(bet: typeof objects.$inferSelect): {
	type: 'good_news' | 'alert'
	title: string
} {
	switch (bet.status) {
		case 'succeeded':
			return { type: 'good_news', title: `Bet succeeded: ${bet.title}` }
		case 'paused':
			return { type: 'alert', title: `Bet paused: ${bet.title}` }
		default:
			return { type: 'alert', title: `Bet failed: ${bet.title}` }
	}
}

async function fanOutBetTerminalNotifications(
	tx: Transaction,
	args: { workspaceId: string; actorId: string; bet: typeof objects.$inferSelect },
): Promise<void> {
	const { workspaceId, actorId, bet } = args

	const subs = await tx
		.select({ actorId: subscriptions.actorId })
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.workspaceId, workspaceId),
				eq(subscriptions.entityType, 'object'),
				eq(subscriptions.entityId, bet.id),
				ne(subscriptions.actorId, actorId),
			),
		)

	if (subs.length === 0) {
		logger.info('Bet reached terminal state, no subscribers to notify', {
			betId: bet.id,
			status: bet.status,
		})
		return
	}

	const { type, title } = betTerminalNotificationContent(bet)

	const created = await insertNotificationsWithEvents(tx, {
		workspaceId,
		actorId,
		rows: subs.map((s) => ({
			workspaceId,
			type,
			title,
			content: null,
			sourceActorId: actorId,
			targetActorId: s.actorId,
			objectId: bet.id,
			status: 'pending' as const,
		})),
	})

	logger.info('Bet reached terminal state, notified subscribers', {
		betId: bet.id,
		status: bet.status,
		notified: created.length,
	})
}

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
	const { ids, patch } = c.req.valid('json')

	// Dedup so duplicates in the request don't double-write or double-report.
	const uniqueIds = Array.from(new Set(ids))

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
		if (patch.driver !== undefined) updateData.driver = patch.driver
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
				const changes = computeChanges(
					plan.previous as unknown as Record<string, unknown>,
					updated as unknown as Record<string, unknown>,
					OBJECT_DIFF_FIELDS,
				)
				await tx.insert(events).values({
					workspaceId: plan.previous.workspaceId,
					actorId,
					action: plan.action,
					entityType: plan.previous.type,
					entityId: plan.id,
					data: { changes },
				})
			}
		})
	}

	const okCount = results.filter((r) => r.ok).length
	logger.info('bulk-update objects', {
		actorId,
		requested: ids.length,
		deduped: uniqueIds.length,
		updated: okCount,
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
