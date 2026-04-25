import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, relationships, workspaces } from '@maskin/db/schema'
import { getAllValidTypes, getEnabledModuleIds } from '@maskin/module-sdk'
import {
	createObjectSchema,
	objectQuerySchema,
	searchObjectsSchema,
	updateObjectSchema,
} from '@maskin/shared'
import { type Column, type SQL, and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { createApiError, createInvalidTypeError } from '../lib/errors'
import {
	errorSchema,
	idParamSchema,
	objectGraphResponseSchema,
	objectResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import type { WorkspaceSettings } from '../lib/types'
import { createMetadataValidationError, validateMetadataFields } from '../lib/validate-metadata'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

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

/** Resolve sort expression — built-in column or metadata->>'field_name'. Returns null for unknown fields. */
function resolveSortColumn(sortField: string): Column | SQL | null {
	if (sortColumns[sortField]) return sortColumns[sortField]
	if (sortField.startsWith('metadata.')) {
		const fieldName = sortField.slice(9)
		if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fieldName)) return null
		return sql`${objects.metadata}->>'${sql.raw(fieldName)}'`
	}
	return null
}

/** Resolve sort + order into a Drizzle orderBy expression, or null for unknown fields. */
function resolveOrderBy(query: { sort: string; order: string }): SQL | null {
	const sortExpr = resolveSortColumn(query.sort)
	if (!sortExpr) return null
	return query.order === 'desc' ? desc(sortExpr) : asc(sortExpr)
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

	const fieldDefs = settings?.field_definitions?.[body.type]
	const metadataErrors = validateMetadataFields(body.type, body.metadata, fieldDefs, {
		mode: 'create',
	})
	if (metadataErrors.length > 0) {
		return c.json(createMetadataValidationError(body.type, metadataErrors), 400)
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

	const conditions = [eq(objects.workspaceId, workspaceId)]
	if (query.type) conditions.push(eq(objects.type, query.type))
	if (query.status) conditions.push(eq(objects.status, query.status))
	if (query.owner) conditions.push(eq(objects.owner, query.owner))
	if (query.ids) {
		const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
		const idList = query.ids.split(',').filter((id) => UUID_RE.test(id))
		if (idList.length > 0) conditions.push(inArray(objects.id, idList))
	}

	const orderBy = resolveOrderBy(query)
	if (!orderBy)
		return c.json(createApiError('BAD_REQUEST', `Unknown sort field: '${query.sort}'`), 400)

	const results = await db
		.select()
		.from(objects)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(orderBy)

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

	const escaped = query.q.replace(/[%_\\]/g, '\\$&')
	const pattern = `%${escaped}%`
	const textMatch = or(ilike(objects.title, pattern), ilike(objects.content, pattern))
	const conditions = [eq(objects.workspaceId, workspaceId)]
	if (textMatch) conditions.push(textMatch)
	if (query.type) conditions.push(eq(objects.type, query.type))
	if (query.status) conditions.push(eq(objects.status, query.status))

	const orderBy = resolveOrderBy(query)
	if (!orderBy)
		return c.json(createApiError('BAD_REQUEST', `Unknown sort field: '${query.sort}'`), 400)

	const results = await db
		.select()
		.from(objects)
		.where(and(...conditions))
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(orderBy)

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

	// Collect connected object IDs
	const connectedIds = new Set<string>()
	for (const rel of rels) {
		if (rel.sourceId !== id) connectedIds.add(rel.sourceId)
		if (rel.targetId !== id) connectedIds.add(rel.targetId)
	}

	// Batch-fetch connected objects
	let connectedObjects: (typeof objects.$inferSelect)[] = []
	if (connectedIds.size > 0) {
		connectedObjects = await db
			.select()
			.from(objects)
			.where(inArray(objects.id, [...connectedIds]))
	}

	return c.json(
		{
			object: serialize(object),
			relationships: serializeArray(rels),
			connected_objects: serializeArray(connectedObjects),
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

	return c.json(serialize(object) as z.infer<typeof objectResponseSchema>, 200)
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

	// Fetch workspace settings if status or metadata is being updated
	const needsSettings = body.status !== undefined || body.metadata !== undefined
	if (needsSettings) {
		const [workspace] = await db
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, existing.workspaceId))
			.limit(1)

		if (workspace) {
			const settings = workspace.settings as WorkspaceSettings

			if (body.status !== undefined) {
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

			if (body.metadata !== undefined) {
				const fieldDefs = settings?.field_definitions?.[existing.type]
				const metadataErrors = validateMetadataFields(existing.type, body.metadata, fieldDefs, {
					mode: 'update',
				})
				if (metadataErrors.length > 0) {
					return c.json(createMetadataValidationError(existing.type, metadataErrors), 400)
				}
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

app.openapi(deleteObjectRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [existing] = await db.select().from(objects).where(eq(objects.id, id)).limit(1)

	if (!existing || !(await isWorkspaceMember(db, actorId, existing.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Object not found'), 404)
	}

	await db.delete(objects).where(eq(objects.id, id))

	await db.insert(events).values({
		workspaceId: existing.workspaceId,
		actorId,
		action: 'deleted',
		entityType: existing.type,
		entityId: id,
		data: existing,
	})

	return c.json({ deleted: true as const }, 200)
})

export default app
