import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, subscriptions } from '@maskin/db/schema'
import {
	markReadBodySchema,
	subscribeBodySchema,
	subscribersQuerySchema,
	unreadQuerySchema,
	unsubscribeBodySchema,
} from '@maskin/shared'
import { and, count, desc, eq, gt, inArray, max, ne, sql } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import {
	autoSubscribe,
	getSubscribers,
	markRead as markReadService,
	unsubscribe as unsubscribeService,
} from '../services/subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>()

/**
 * Per-entity-type workspace membership check. Returns true if the entity
 * exists in the given workspace. Every value of `subscribableEntityTypeSchema`
 * MUST have a verifier here — otherwise `verifyEntityInWorkspace` throws and
 * the route fails loud (500), preventing a silent cross-workspace info leak
 * when new entity types are added to the schema but not wired up here.
 */
const entityWorkspaceVerifiers: Record<
	string,
	(db: Database, workspaceId: string, entityId: string) => Promise<boolean>
> = {
	object: async (db, workspaceId, entityId) => {
		const [row] = await db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.id, entityId), eq(objects.workspaceId, workspaceId)))
			.limit(1)
		return Boolean(row)
	},
}

async function verifyEntityInWorkspace(
	db: Database,
	workspaceId: string,
	entityType: string,
	entityId: string,
): Promise<boolean> {
	const verifier = entityWorkspaceVerifiers[entityType]
	if (!verifier) {
		throw new Error(
			`No workspace verifier registered for entity_type='${entityType}'. Add one to entityWorkspaceVerifiers in routes/subscriptions.ts before exposing this type via the API.`,
		)
	}
	return verifier(db, workspaceId, entityId)
}

const subscribersResponseSchema = z.object({
	actors: z.array(
		z.object({
			id: z.string().uuid(),
			type: z.string(),
			name: z.string(),
		}),
	),
})

const unreadItemSchema = z.object({
	entity_type: z.string(),
	entity_id: z.string().uuid(),
	unread_count: z.number(),
	latest_event_id: z.number().nullable(),
	latest_activity_at: z.string().nullable(),
	object: objectResponseSchema.optional(),
})

const unreadResponseSchema = z.object({
	items: z.array(unreadItemSchema),
})

// POST /api/subscriptions — manually subscribe the current actor.
const subscribeRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Subscriptions'],
	summary: 'Subscribe current actor to an entity',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: subscribeBodySchema } } },
	},
	responses: {
		201: {
			description: 'Subscribed',
			content: { 'application/json': { schema: z.object({ subscribed: z.literal(true) }) } },
		},
		404: {
			description: 'Entity not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(subscribeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const exists = await verifyEntityInWorkspace(db, workspaceId, body.entity_type, body.entity_id)
	if (!exists) return c.json(createApiError('NOT_FOUND', 'Entity not found'), 404)

	await autoSubscribe(db, {
		workspaceId,
		actorId,
		entityType: body.entity_type,
		entityId: body.entity_id,
		source: 'manual',
	})

	return c.json({ subscribed: true as const }, 201)
})

// DELETE /api/subscriptions — unsubscribe the current actor.
const unsubscribeRoute = createRoute({
	method: 'delete',
	path: '/',
	tags: ['Subscriptions'],
	summary: 'Unsubscribe current actor from an entity',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: unsubscribeBodySchema } } },
	},
	responses: {
		200: {
			description: 'Unsubscribed',
			content: { 'application/json': { schema: z.object({ unsubscribed: z.literal(true) }) } },
		},
	},
})

app.openapi(unsubscribeRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	await unsubscribeService(db, {
		actorId,
		entityType: body.entity_type,
		entityId: body.entity_id,
	})

	return c.json({ unsubscribed: true as const }, 200)
})

// GET /api/subscriptions/subscribers?entity_type=…&entity_id=…
const listSubscribersRoute = createRoute({
	method: 'get',
	path: '/subscribers',
	tags: ['Subscriptions'],
	summary: 'List actors subscribed to an entity',
	request: {
		headers: workspaceIdHeader,
		query: subscribersQuerySchema,
	},
	responses: {
		200: {
			description: 'Subscribers',
			content: { 'application/json': { schema: subscribersResponseSchema } },
		},
		404: {
			description: 'Entity not found in this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listSubscribersRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { entity_type, entity_id } = c.req.valid('query')

	// Verify the entity belongs to the caller's workspace before exposing
	// its subscriber list — otherwise any workspace member could probe
	// cross-workspace entity IDs and read back W2's subscriber actors.
	const exists = await verifyEntityInWorkspace(db, workspaceId, entity_type, entity_id)
	if (!exists) return c.json(createApiError('NOT_FOUND', 'Entity not found'), 404)

	const rows = await getSubscribers(db, {
		workspaceId,
		entityType: entity_type,
		entityId: entity_id,
	})
	return c.json({ actors: rows })
}) as RouteHandler<typeof listSubscribersRoute, Env>)

// POST /api/subscriptions/read — advance the high-water-mark.
const markReadRoute = createRoute({
	method: 'post',
	path: '/read',
	tags: ['Subscriptions'],
	summary: 'Mark an entity as read up to a given event id',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: markReadBodySchema } } },
	},
	responses: {
		200: {
			description: 'Read state updated',
			content: { 'application/json': { schema: z.object({ updated: z.literal(true) }) } },
		},
		404: {
			description: 'Entity not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(markReadRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// Verify the entity belongs to the caller's workspace before writing a
	// read_state row — otherwise any workspace member could pollute the table
	// with rows pointing at foreign entity_ids they can't actually see.
	const exists = await verifyEntityInWorkspace(db, workspaceId, body.entity_type, body.entity_id)
	if (!exists) return c.json(createApiError('NOT_FOUND', 'Entity not found'), 404)

	await markReadService(db, {
		workspaceId,
		actorId,
		entityType: body.entity_type,
		entityId: body.entity_id,
		lastReadEventId: body.last_event_id,
	})

	return c.json({ updated: true as const }, 200)
})

// GET /api/subscriptions/unread — entities the actor is subscribed to with unread > 0.
const listUnreadRoute = createRoute({
	method: 'get',
	path: '/unread',
	tags: ['Subscriptions'],
	summary: 'List entities with unread activity for the current actor',
	request: {
		headers: workspaceIdHeader,
		query: unreadQuerySchema,
	},
	responses: {
		200: {
			description: 'Unread items',
			content: { 'application/json': { schema: unreadResponseSchema } },
		},
	},
})

app.openapi(listUnreadRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { entity_type } = c.req.valid('query')

	// Single query: for each (entity_type, entity_id) the actor is subscribed to
	// in this workspace, count commented events whose id > last_read_event_id and
	// whose actor_id is not the viewer's. Exclude rows with zero unread.
	const lastReadExpr = sql<number>`coalesce(
		(select last_read_event_id from read_state
			where actor_id = ${actorId}
				and entity_type = ${subscriptions.entityType}
				and entity_id = ${subscriptions.entityId}),
		0
	)`

	const subConditions = [
		eq(subscriptions.workspaceId, workspaceId),
		eq(subscriptions.actorId, actorId),
	]
	if (entity_type) subConditions.push(eq(subscriptions.entityType, entity_type))

	const rows = await db
		.select({
			entityType: subscriptions.entityType,
			entityId: subscriptions.entityId,
			unreadCount: count(events.id),
			latestEventId: max(events.id),
			latestActivityAt: max(events.createdAt),
		})
		.from(subscriptions)
		.leftJoin(
			events,
			and(
				eq(events.workspaceId, subscriptions.workspaceId),
				eq(events.entityType, subscriptions.entityType),
				eq(events.entityId, subscriptions.entityId),
				eq(events.action, 'commented'),
				ne(events.actorId, actorId),
				gt(events.id, lastReadExpr),
			),
		)
		.where(and(...subConditions))
		.groupBy(subscriptions.entityType, subscriptions.entityId)
		.having(gt(count(events.id), 0))
		.orderBy(desc(max(events.id)))

	// Hydrate object summaries for entity_type='object'. Other entity types just
	// return the raw counts in v1 — UI consumers add their own loader when they
	// become subscribable. Scoped to workspaceId so a stale subscription row
	// pointing at a foreign object can never expose it cross-workspace.
	const objectIds = rows.filter((r) => r.entityType === 'object').map((r) => r.entityId)
	const objectsById = new Map<string, typeof objects.$inferSelect>()
	if (objectIds.length > 0) {
		const fetched = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
		for (const o of fetched) objectsById.set(o.id, o)
	}

	const items = rows.map((r) => {
		const obj = r.entityType === 'object' ? objectsById.get(r.entityId) : undefined
		return {
			entity_type: r.entityType,
			entity_id: r.entityId,
			unread_count: r.unreadCount,
			latest_event_id: r.latestEventId,
			latest_activity_at:
				r.latestActivityAt instanceof Date ? r.latestActivityAt.toISOString() : r.latestActivityAt,
			...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
		}
	})

	return c.json({ items })
}) as RouteHandler<typeof listUnreadRoute, Env>)

export default app
