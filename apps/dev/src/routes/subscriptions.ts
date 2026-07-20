import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, subscriptions } from '@maskin/db/schema'
import {
	LOOP_ATTENTION_STATUSES,
	TERMINAL_BET_STATUSES,
	markReadBodySchema,
	subscribeBodySchema,
	subscribersQuerySchema,
	unreadQuerySchema,
	unsubscribeBodySchema,
} from '@maskin/shared'
import { and, count, desc, eq, gt, inArray, max, ne, or, sql } from 'drizzle-orm'
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
	// Total unread activity count. Includes both comments (action='commented') and
	// terminal bet status transitions (action='status_changed', status in
	// succeeded/failed). A bet with only a terminal transition and no comments will
	// have unread_count=1 and mentioning_unread_count=0.
	unread_count: z.number(),
	// Count of unread events that actually @-mention the current actor. Per-event
	// grain — not a bool_or rollup — so a single buried mention among nine
	// agent→agent comments yields 1. The For You card surfaces the "Mentioned"
	// pill when > 0.
	mentioning_unread_count: z.number(),
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

	// Per-event mention count: how many of the unread events on this entity
	// actually @-mention the current actor. Replaces the object-level bool_or
	// that previously flagged the whole object as "mentions you" the moment a
	// single buried mention existed, dragging agent-to-agent comments into
	// human For You with it. Counted at the event grain, so the share of
	// objects flagged tracks the share of comments that actually mention.
	const mentioningUnreadCountExpr = sql<number>`coalesce(count(*) filter (where ${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)), 0)::int`

	// `status_changed` events carry the new-shape `data.changes` diff array
	// (see bet/mcp-response-shape) going forward, but historical rows before
	// that migration still carry the legacy `{previous, updated}` snapshot —
	// read whichever is present so old terminal transitions don't drop out of
	// the unread feed. The third fallback (`data->>'status'`) reads the
	// initial status on a `created` event, whose `data` payload is the full
	// object row — used by the Loop `created` arm below so a Loop born at
	// `at-risk`/`breached` surfaces without waiting for a subsequent
	// transition. `commented` and `status_changed` payloads never carry a
	// top-level `status` field, so this fallback is safe for them.
	const statusExpr = sql<string>`coalesce(
		${events.data}->'updated'->>'status',
		jsonb_path_query_first(${events.data}, '$.changes[*] ? (@.field == "status")')->>'new',
		${events.data}->>'status'
	)`

	const rows = await db
		.select({
			entityType: subscriptions.entityType,
			entityId: subscriptions.entityId,
			unreadCount: count(events.id),
			mentioningUnreadCount: mentioningUnreadCountExpr,
			latestEventId: max(events.id),
			latestActivityAt: max(events.createdAt),
		})
		.from(subscriptions)
		.leftJoin(
			objects,
			and(eq(subscriptions.entityType, 'object'), eq(objects.id, subscriptions.entityId)),
		)
		.leftJoin(
			events,
			and(
				eq(events.workspaceId, subscriptions.workspaceId),
				eq(events.entityId, subscriptions.entityId),
				ne(events.actorId, actorId),
				gt(events.id, lastReadExpr),
				// Three surfaces land in the unread feed:
				// (1) comments on the subscribed entity (events.entity_type matches the
				//     subscription's polymorphic type, e.g. 'object'), and
				// (2) the bet's own terminal-status transition (events.entity_type is
				//     the object's concrete type, e.g. 'bet', while the subscription's
				//     entityType is 'object'). The entityType guard on this arm is
				//     explicit to prevent other subscribable entity types from
				//     accidentally matching bet terminal events via entityId alone.
				// TERMINAL_BET_STATUSES (succeeded/failed/paused) is the single
				// source of truth shared with the notification fan-out gate in
				// objects.ts — without (2) a watcher misses the terminal signal, see
				// T2 on bet/notif-cascade-fix.
				// (3) a Loop transitioning into an attention-worthy status
				//     (at-risk / breached) — mirrors (2) for the Loop primitive.
				//     Uses `type='loop'` in the polymorphic filter path per T2 on
				//     bet/loops-primitive; a transition back to `holding` is
				//     quiet news and does not land in the feed.
				//     LOOP_ATTENTION_STATUSES is the single source of truth shared
				//     with the briefing composer's health-priority sort.
				// (4) a Loop born already at an attention-worthy status — QA on
				//     bet/loops-primitive found seeded `at-risk`/`breached` Loops
				//     silent in the feed because their `created` event emits an
				//     initial-status payload, not a transition. Mirrors (3) via
				//     the `data->>'status'` fallback in `statusExpr` above; a
				//     Loop born at `holding` stays quiet.
				// Unlike TERMINAL_BET_STATUSES, a loop's status is never permanent —
				// it can flip back to `holding` after arm (3) or (4) already matched an
				// older unread event. Both loop arms additionally require the object's
				// CURRENT status (via the `objects` join above) to still be
				// attention-worthy, so a recovered loop stops surfacing once it's read
				// back to `holding` even if the triggering event is still unread.
				or(
					and(eq(events.entityType, subscriptions.entityType), eq(events.action, 'commented')),
					and(
						eq(subscriptions.entityType, 'object'),
						eq(events.entityType, 'bet'),
						eq(events.action, 'status_changed'),
						inArray(statusExpr, [...TERMINAL_BET_STATUSES]),
					),
					and(
						eq(subscriptions.entityType, 'object'),
						eq(events.entityType, 'loop'),
						eq(events.action, 'status_changed'),
						inArray(statusExpr, [...LOOP_ATTENTION_STATUSES]),
						inArray(objects.status, [...LOOP_ATTENTION_STATUSES]),
					),
					and(
						eq(subscriptions.entityType, 'object'),
						eq(events.entityType, 'loop'),
						eq(events.action, 'created'),
						inArray(statusExpr, [...LOOP_ATTENTION_STATUSES]),
						inArray(objects.status, [...LOOP_ATTENTION_STATUSES]),
					),
				),
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
			mentioning_unread_count: Number(r.mentioningUnreadCount),
			latest_event_id: r.latestEventId,
			latest_activity_at:
				r.latestActivityAt instanceof Date ? r.latestActivityAt.toISOString() : r.latestActivityAt,
			...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
		}
	})

	return c.json({ items })
}) as RouteHandler<typeof listUnreadRoute, Env>)

export default app
