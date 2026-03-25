import type { Database } from '@ai-native/db'
import { objects, relationships } from '@ai-native/db/schema'
import { createRelationshipSchema, relationshipQuerySchema } from '@ai-native/shared'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { and, eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logEvent } from '../lib/log-event'
import {
	errorSchema,
	idParamSchema,
	relationshipResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
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

	const [created] = await db
		.insert(relationships)
		.values({
			sourceType: body.source_type,
			sourceId: body.source_id,
			targetType: body.target_type,
			targetId: body.target_id,
			type: body.type,
			createdBy: actorId,
		})
		.returning()

	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create relationship'), 500)
	}

	await logEvent(db, {
		workspaceId,
		actorId,
		action: 'created',
		entityType: 'relationship',
		entityId: created.id,
		data: created,
	})

	return c.json(serialize(created) as z.infer<typeof relationshipResponseSchema>, 201)
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
	if (query.source_id) conditions.push(eq(relationships.sourceId, query.source_id))
	if (query.target_id) conditions.push(eq(relationships.targetId, query.target_id))
	if (query.type) conditions.push(eq(relationships.type, query.type))

	const results = await db
		.select()
		.from(relationships)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(relationships.createdAt)

	return c.json(serializeArray(results) as z.infer<typeof relationshipResponseSchema>[])
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
		await logEvent(db, {
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
