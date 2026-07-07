import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database, Transaction } from '@maskin/db'
import { events, files, objects, relationships } from '@maskin/db/schema'
import { createRelationshipSchema, relationshipQuerySchema } from '@maskin/shared'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
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

// Must run inside the same transaction as the relationship/event inserts —
// otherwise a failure here would leave an already-committed relationship
// behind a 500 response, and an idempotency-key retry would then hit the
// relationships unique constraint instead of the original error.
async function stampKnowledgeInvalid(
	tx: Transaction,
	sourceId: string,
	targetId: string,
	actorId: string,
) {
	const endpoints = await tx
		.select({
			id: objects.id,
			type: objects.type,
			workspaceId: objects.workspaceId,
		})
		.from(objects)
		.where(inArray(objects.id, [sourceId, targetId]))
	const source = endpoints.find((e) => e.id === sourceId)
	const target = endpoints.find((e) => e.id === targetId)
	if (source?.type !== 'knowledge' || target?.type !== 'knowledge') return

	const now = new Date()
	// Merge one key into whatever metadata the target already has — knowledge
	// objects carry confidence/verification_status/etc. as ordinary metadata
	// keys, same as every other type's custom fields, so this never clobbers them.
	await tx
		.update(objects)
		.set({
			metadata: sql`coalesce(${objects.metadata}, '{}'::jsonb) || jsonb_build_object('t_invalid', ${now.toISOString()}::text)`,
			updatedAt: now,
		})
		.where(eq(objects.id, target.id))

	await tx.insert(events).values({
		workspaceId: target.workspaceId,
		actorId,
		action: 'updated',
		entityType: 'knowledge',
		entityId: target.id,
		data: { t_invalid: now.toISOString() },
	})
}

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

	let created: typeof relationships.$inferSelect | undefined
	try {
		created = await db.transaction(async (tx) => {
			const [row] = await tx
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

			if (!row) {
				throw new Error('Failed to create relationship')
			}

			await tx.insert(events).values({
				workspaceId,
				actorId,
				action: 'created',
				entityType: 'relationship',
				entityId: row.id,
				data: row,
			})

			// Bi-temporal invalidation: creating a supersedes/contradicts edge between
			// two knowledge objects stamps t_invalid in the target's metadata rather
			// than deleting the old row. The target stays queryable via t_invalid.
			// Runs in the same transaction so a failure here rolls back the
			// relationship + event inserts too, instead of leaving them committed
			// behind a 500 response.
			if (row.type === 'supersedes' || row.type === 'contradicts') {
				await stampKnowledgeInvalid(tx, row.sourceId, row.targetId, actorId)
			}

			return row
		})
	} catch (err) {
		logger.error('Relationship creation transaction failed', { error: String(err) })
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create relationship'), 500)
	}

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

	const results = await db
		.select()
		.from(relationships)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.limit(query.limit)
		.offset(query.offset)
		.orderBy(relationships.createdAt)

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
