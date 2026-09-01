import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, subscriptions } from '@maskin/db/schema'
import {
	commentDecisionSchema,
	markReadBodySchema,
	markUnreadBodySchema,
	subscribeBodySchema,
	subscribersQuerySchema,
	unreadQuerySchema,
	unsubscribeBodySchema,
} from '@maskin/shared'
import { and, count, desc, eq, gt, inArray, max, ne, or, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import {
	autoSubscribe,
	getSubscribers,
	markRead as markReadService,
	markUnread as markUnreadService,
	unsubscribe as unsubscribeService,
} from '../services/subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

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
	// Total unread activity count. For You only surfaces comments that actually
	// @-mention the current actor (action='commented', data.mentions contains
	// their actor id) — see the query below. The one exception is an
	// onboarding_session object, whose coach replies all count as unread
	// regardless of mention, since the coach doesn't @-mention on every turn.
	unread_count: z.number(),
	// Count of unread events that actually @-mention the current actor. Equal to
	// unread_count for every entity except onboarding_session objects, where a
	// coach reply can be unread (non-zero unread_count) without mentioning the
	// actor (mentioning_unread_count stays 0).
	mentioning_unread_count: z.number(),
	// Highest attention score (1-5) among this entity's unread comments — same
	// join scope as unread_count (so an onboarding coach reply's score counts
	// even without a mention). null when none of the unread comments carry an
	// attention score — the Priority sort on For You treats that as the lowest
	// tier, below any scored comment.
	max_unread_attention: z.number().nullable(),
	latest_event_id: z.number().nullable(),
	latest_activity_at: z.string().nullable(),
	object: objectResponseSchema.optional(),
	// The comment that put this card in the feed. Every For You item exists
	// because an agent @-mentioned the reader (see the join predicate below), so
	// the card leads with this rather than with the object's own title and
	// description — those are stable across every mention on the object, and are
	// one click away on the object page.
	latest_mention: z
		.object({
			event_id: z.number(),
			actor_id: z.string().uuid().nullable(),
			created_at: z.string(),
			// The whole comment. For You is where the reader decides, so the card
			// must not send them elsewhere to finish reading the ask; the body is
			// bounded by createCommentSchema's 2000-character cap.
			content: z.string(),
			attention: z.number().nullable(),
			// Present only when the agent asked for a structured decision. The
			// card renders its options as the buttons the reader taps.
			decision: commentDecisionSchema.nullable(),
		})
		.optional(),
})

type LatestMention = NonNullable<z.infer<typeof unreadItemSchema>['latest_mention']>

/**
 * Projects a `commented` event row into the feed's mention payload.
 *
 * The decision block is re-parsed rather than trusted: it was validated on the
 * way in, but rows predating that gate — or written by a future caller that
 * skips it — would otherwise reach the card as a malformed set of buttons. A
 * block that no longer parses degrades to `null`, and the card falls back to
 * rendering the comment body.
 */
function toLatestMention(event: typeof events.$inferSelect): LatestMention {
	const data = (event.data ?? {}) as Record<string, unknown>
	const rawContent = typeof data.content === 'string' ? data.content : ''
	const attention = Number(data.attention)
	const decision = commentDecisionSchema.safeParse(data.decision)

	return {
		event_id: Number(event.id),
		actor_id: event.actorId ?? null,
		created_at:
			event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt),
		content: rawContent,
		attention: Number.isFinite(attention) ? attention : null,
		decision: decision.success ? decision.data : null,
	}
}

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

// POST /api/subscriptions/unread — Slack-style toggle back to unread.
// Deletes the actor's read_state row so every event on the entity reappears
// in their unread feed on the next read. Mirrors the shape of `POST /read`
// (same entity_type + entity_id validation, same workspace-membership
// guard) but carries no last_event_id.
const markUnreadRoute = createRoute({
	method: 'post',
	path: '/unread',
	tags: ['Subscriptions'],
	summary: 'Mark an entity as unread (clear the actor’s read high-water-mark)',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: markUnreadBodySchema } } },
	},
	responses: {
		200: {
			description: 'Read state cleared',
			content: { 'application/json': { schema: z.object({ updated: z.literal(true) }) } },
		},
		404: {
			description: 'Entity not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(markUnreadRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	// Same cross-workspace guard as POST /read — refuse to touch a row
	// pointing at an entity_id the caller can't actually see in this
	// workspace, even though the delete is scoped to the actor.
	const exists = await verifyEntityInWorkspace(db, workspaceId, body.entity_type, body.entity_id)
	if (!exists) return c.json(createApiError('NOT_FOUND', 'Entity not found'), 404)

	await markUnreadService(db, {
		actorId,
		entityType: body.entity_type,
		entityId: body.entity_id,
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
	const { entity_type, include_recently_read: includeRecentlyRead } = c.req.valid('query')

	// Single query: for each (entity_type, entity_id) the actor is subscribed to
	// in this workspace, join the events that count as unread (id > last_read
	// and not by the viewer) plus, when the caller opted in, any read events
	// still within the recently-read window. `unread_count` is computed via
	// FILTER so a recently-read card returns unread_count = 0 while still
	// appearing in the feed.
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

	// Restricts the join to events that could contribute a row: unread ones,
	// plus (when opted in) read events still inside a 48h window. Read events
	// outside the window drop here so aggregates don't scan the whole entity
	// history on hot threads. 48h covers the Today and Yesterday buckets the
	// ForYouDashboard renders (mirrors iOS Mail's mark-unread horizon).
	const readOrRecentPredicate = includeRecentlyRead
		? sql`(${events.id} > ${lastReadExpr} or ${events.createdAt} >= now() - interval '48 hours')`
		: sql`${events.id} > ${lastReadExpr}`

	// Per-event mention count: how many of the *unread* events on this entity
	// actually @-mention the current actor. Recently-read events never count
	// toward the mention pill even when they're joined.
	const mentioningUnreadCountExpr = sql<number>`coalesce(count(*) filter (where ${events.id} > ${lastReadExpr} and ${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)), 0)::int`

	// True unread count regardless of whether recently-read events are joined.
	const unreadCountExpr = sql<number>`coalesce(count(${events.id}) filter (where ${events.id} > ${lastReadExpr}), 0)::int`

	// Highest attention score among this entity's *joined* unread comments, for
	// the Priority sort on For You — same join scope as unread_count (mentioning
	// comments, plus any onboarding_session coach reply regardless of mention;
	// see the join predicate below), not the narrower mentioning_unread_count
	// scope. Comments without an attention score don't contribute a value —
	// max() over an all-null filtered set returns null, which the frontend
	// sorts below any scored comment.
	const maxUnreadAttentionExpr = sql<
		number | null
	>`max((${events.data}->>'attention')::int) filter (where ${events.id} > ${lastReadExpr})`

	const rows = await db
		.select({
			entityType: subscriptions.entityType,
			entityId: subscriptions.entityId,
			unreadCount: unreadCountExpr,
			mentioningUnreadCount: mentioningUnreadCountExpr,
			maxUnreadAttention: maxUnreadAttentionExpr,
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
				readOrRecentPredicate,
				// Two surfaces land in the unread feed, both scoped to comments only
				// (status-change/terminal-bet/commitment-attention signals were
				// dropped from For You — mentions are the only trigger now):
				// (1) a comment that actually @-mentions this actor specifically —
				//     `data.mentions` is the per-comment array of actor ids passed on
				//     POST /api/events, checked with `@>` containment against this
				//     actor's own id so a comment that mentions a different actor in
				//     the same workspace never counts.
				// (2) the onboarding coach conversation — any comment on an
				//     onboarding_session object the actor owns counts as unread
				//     regardless of mention, since the coach doesn't @-mention the
				//     human on every turn. Carve-out for a pre-existing, unrelated
				//     feature; everything else in the feed is mentions-only.
				or(
					and(
						eq(events.entityType, subscriptions.entityType),
						eq(events.action, 'commented'),
						sql`${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)`,
					),
					and(
						eq(subscriptions.entityType, 'object'),
						eq(events.entityType, 'object'),
						eq(events.action, 'commented'),
						eq(objects.type, 'onboarding_session'),
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

	// Hydrate the mention comment itself. `latest_event_id` is max(events.id)
	// over the join scope above, and that scope is mentions-only, so the newest
	// joined event *is* the newest comment mentioning this actor — fetching
	// those ids directly is exact. Deliberately a second keyed query rather than
	// a correlated subquery inside the aggregate: Drizzle column objects
	// interpolated into a correlated `sql` template render unqualified and bind
	// to the wrong table, which fails silently (see .claude/rules/known-pitfalls.md).
	const mentionEventIds = rows
		.map((r) => r.latestEventId)
		.filter((id): id is number => typeof id === 'number')
	const mentionsByEventId = new Map<number, typeof events.$inferSelect>()
	if (mentionEventIds.length > 0) {
		const fetched = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), inArray(events.id, mentionEventIds)))
		for (const e of fetched) mentionsByEventId.set(Number(e.id), e)
	}

	const items = rows.map((r) => {
		const obj = r.entityType === 'object' ? objectsById.get(r.entityId) : undefined
		const mentionEvent =
			r.latestEventId == null ? undefined : mentionsByEventId.get(Number(r.latestEventId))
		return {
			entity_type: r.entityType,
			entity_id: r.entityId,
			unread_count: Number(r.unreadCount),
			mentioning_unread_count: Number(r.mentioningUnreadCount),
			max_unread_attention: r.maxUnreadAttention == null ? null : Number(r.maxUnreadAttention),
			latest_event_id: r.latestEventId,
			latest_activity_at:
				r.latestActivityAt instanceof Date ? r.latestActivityAt.toISOString() : r.latestActivityAt,
			...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
			...(mentionEvent ? { latest_mention: toLatestMention(mentionEvent) } : {}),
		}
	})

	return c.json({ items })
}) as RouteHandler<typeof listUnreadRoute, Env>)

export default app
