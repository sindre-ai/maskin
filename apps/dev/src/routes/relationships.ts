import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, files, objects, relationships } from '@maskin/db/schema'
import { createRelationshipSchema, relationshipQuerySchema } from '@maskin/shared'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import { buildCreatedAtCursorConditions, useKeysetSeek } from '../lib/cursor-pagination'
import { createApiError } from '../lib/errors'
import {
	errorSchema,
	idParamSchema,
	relationshipResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { isWorkspaceMember } from '../lib/workspace-auth'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

// POST /api/relationships
const createRelationshipRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['relationships'],
	summary: 'Create relationship',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: createRelationshipSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Relationship created',
			content: { 'application/json': { schema: relationshipResponseSchema } },
		},
		400: {
			description: 'Missing workspace header',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createRelationshipRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const body = c.req.valid('json')

	// Resolve sourceType/targetType server-side per T1 convention B:
	// 'file' when the endpoint id lives in files, 'object' otherwise.
	// Caller-supplied type labels are ignored.
	const endpointIds = [body.source_id, body.target_id]
	const fileRows = await db
		.select({ id: files.id })
		.from(files)
		.where(and(eq(files.workspaceId, workspaceId), inArray(files.id, endpointIds)))
	const fileIds = new Set(fileRows.map((r) => r.id))
	const sourceType = fileIds.has(body.source_id) ? 'file' : 'object'
	const targetType = fileIds.has(body.target_id) ? 'file' : 'object'

	const [created] = await db
		.insert(relationships)
		.values({
			sourceType,
			sourceId: body.source_id,
			targetType,
			targetId: body.target_id,
			type: body.type,
			createdBy: actorId,
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create relationship'), 500)
	}

	await db.insert(events).values({
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'relationship',
		entityId: created.id,
		data: created,
	})

	const endpointRows = await db
		.select({ id: objects.id, title: objects.title })
		.from(objects)
		.where(inArray(objects.id, [created.sourceId, created.targetId]))
	const titleById = new Map(endpointRows.map((r) => [r.id, r.title ?? null]))

	return c.json(
		{
			...serialize(created),
			sourceTitle: titleById.get(created.sourceId) ?? null,
			targetTitle: titleById.get(created.targetId) ?? null,
		} as z.infer<typeof relationshipResponseSchema>,
		201,
	)
})

// GET /api/relationships
const listRelationshipsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['relationships'],
	summary: 'List relationships with filters',
	request: {
		query: relationshipQuerySchema,
	},
	responses: {
		200: {
			description: 'List of relationships',
			content: { 'application/json': { schema: z.array(relationshipResponseSchema) } },
		},
	},
})

app.openapi(listRelationshipsRoute, async (c) => {
	const db = c.get('db')
	const query = c.req.valid('query')

	const conditions = []
	if (query.object_id) {
		conditions.push(
			or(eq(relationships.sourceId, query.object_id), eq(relationships.targetId, query.object_id)),
		)
	}
	if (query.source_id) conditions.push(eq(relationships.sourceId, query.source_id))
	if (query.target_id) conditions.push(eq(relationships.targetId, query.target_id))
	if (query.type) conditions.push(eq(relationships.type, query.type))
	conditions.push(
		...buildCreatedAtCursorConditions(
			{ createdAt: relationships.createdAt, id: relationships.id },
			query,
		),
	)

	// When `snapshot_at` engages the cursor path, switch to a stable
	// (createdAt, id) tuple so the keyset seek predicate agrees with the sort.
	const cursorOn = Boolean(query.snapshot_at)
	const orderBy = cursorOn
		? query.order === 'asc'
			? [asc(relationships.createdAt), asc(relationships.id)]
			: [desc(relationships.createdAt), asc(relationships.id)]
		: [relationships.createdAt]

	const skipOffset = useKeysetSeek(query)
	const results = await db
		.select()
		.from(relationships)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.limit(query.limit)
		.offset(skipOffset ? 0 : query.offset)
		.orderBy(...orderBy)

	const endpointIds = new Set<string>()
	for (const r of results) {
		endpointIds.add(r.sourceId)
		endpointIds.add(r.targetId)
	}
	const titleById = new Map<string, string | null>()
	if (endpointIds.size > 0) {
		const endpointRows = await db
			.select({ id: objects.id, title: objects.title })
			.from(objects)
			.where(inArray(objects.id, [...endpointIds]))
		for (const row of endpointRows) titleById.set(row.id, row.title ?? null)
	}

	return c.json(
		results.map((r) => ({
			...serialize(r),
			sourceTitle: titleById.get(r.sourceId) ?? null,
			targetTitle: titleById.get(r.targetId) ?? null,
		})) as z.infer<typeof relationshipResponseSchema>[],
	)
})

// DELETE /api/relationships/:id
const deleteRelationshipRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['relationships'],
	summary: 'Delete relationship',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'Relationship deleted',
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
		},
		404: {
			description: 'Relationship not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(deleteRelationshipRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const workspaceId = c.req.header('X-Workspace-Id')
	const { id } = c.req.valid('param')

	const [existing] = await db.select().from(relationships).where(eq(relationships.id, id)).limit(1)

	if (!existing) return c.json(createApiError('NOT_FOUND', 'Relationship not found'), 404)

	// Verify actor is a member of the workspace that owns the source object
	const [sourceObject] = await db
		.select({ workspaceId: objects.workspaceId })
		.from(objects)
		.where(eq(objects.id, existing.sourceId))
		.limit(1)
	if (!sourceObject || !(await isWorkspaceMember(db, actorId, sourceObject.workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Relationship not found'), 404)
	}

	await db.delete(relationships).where(eq(relationships.id, id))

	if (workspaceId) {
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'deleted',
			entityType: 'relationship',
			entityId: id,
			data: existing,
		})
	}

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteRelationshipRoute, Env>)

export default app
