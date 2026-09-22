import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { files, objects, relationships } from '@maskin/db/schema'
import { createRelationshipSchema, relationshipQuerySchema } from '@maskin/shared'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import { maybeEmitKnowledgeReferenceFromEdge } from '../lib/analytics/knowledge-events'
import { buildCreatedAtCursorConditions, useKeysetSeek } from '../lib/cursor-pagination'
import { createApiError, validationFailureHook } from '../lib/errors'
import { capturePosthogRelationshipCreated, recordEvent } from '../lib/events/record-event'
import { resolveEndpointTitles } from '../lib/graph/endpoint-titles'
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

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

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

	// Idempotent on (source_id, target_id, type) — matches
	// `relationships_src_tgt_type_uniq`. A duplicate call returns 201 with the
	// existing row and does NOT re-fire the audit event or the
	// `workspace_knowledge_referenced` ship-metric emit (per T2 idempotency
	// clause — one edge, one emit).
	const insertedRows = await db
		.insert(relationships)
		.values({
			sourceType,
			sourceId: body.source_id,
			targetType,
			targetId: body.target_id,
			type: body.type,
			createdBy: actorId,
		})
		.onConflictDoNothing({
			target: [relationships.sourceId, relationships.targetId, relationships.type],
		})
		.returning()

	let created = insertedRows[0]
	const isNewInsert = Boolean(created)
	if (!created) {
		const [existing] = await db
			.select()
			.from(relationships)
			.where(
				and(
					eq(relationships.sourceId, body.source_id),
					eq(relationships.targetId, body.target_id),
					eq(relationships.type, body.type),
				),
			)
			.limit(1)
		if (!existing) {
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to create relationship'), 500)
		}
		created = existing
	}

	if (isNewInsert) {
		await recordEvent(db, {
			workspaceId,
			actorId,
			action: 'created',
			entityType: 'relationship',
			entityId: created.id,
			data: created,
		})

		// PostHog · one capture per relationship write, source of truth for
		// the ship-metric across every prod writer. Fire-and-forget.
		capturePosthogRelationshipCreated(actorId, {
			workspaceId,
			sourceType: created.sourceType,
			targetType: created.targetType,
			type: created.type,
		})

		// Auto-emit ship-metric when the new edge is a `derived_from` pointing at
		// a `knowledge` object. Best-effort — never blocks the response.
		await maybeEmitKnowledgeReferenceFromEdge(db, {
			workspaceId,
			actorId,
			edgeType: created.type,
			sourceId: created.sourceId,
			targetId: created.targetId,
		})
	}

	// Titles hydrate from `objects` when the endpoint is an object row. The
	// UI attach flow never mints a conversation or session endpoint here (that
	// would violate spec §No-gos — users don't hand-write those edges), so
	// this stays object-only for the response.
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

	// Partition endpoint ids by the stored `sourceType` / `targetType` label so
	// the batch lookup can hit the right table for each kind. Legacy edges
	// written with a specialised label (`'insight'`, `'bet'`, `'task'`,
	// `'knowledge'`) fall through to the object path — matches the same
	// fallback GET /api/objects/:id/graph uses for those rows.
	const objectIds = new Set<string>()
	const conversationIds = new Set<string>()
	const sessionIds = new Set<string>()
	for (const r of results) {
		bucket(r.sourceType, r.sourceId, objectIds, conversationIds, sessionIds)
		bucket(r.targetType, r.targetId, objectIds, conversationIds, sessionIds)
	}
	const titleById = await resolveEndpointTitles(db, {
		objectIds: [...objectIds],
		conversationIds: [...conversationIds],
		sessionIds: [...sessionIds],
	})

	return c.json(
		results.map((r) => ({
			...serialize(r),
			sourceTitle: titleById.get(r.sourceId) ?? null,
			targetTitle: titleById.get(r.targetId) ?? null,
		})) as z.infer<typeof relationshipResponseSchema>[],
	)
})

function bucket(
	kind: string,
	id: string,
	objectIds: Set<string>,
	conversationIds: Set<string>,
	sessionIds: Set<string>,
): void {
	if (kind === 'conversation') conversationIds.add(id)
	else if (kind === 'session') sessionIds.add(id)
	else objectIds.add(id) // 'object', 'file' (files hydrated by Task 1 elsewhere), any legacy label
}

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
		await recordEvent(db, {
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
