import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, workspaceMembers } from '@maskin/db/schema'
import {
	commentDecisionSchema,
	markReadBodySchema,
	markUnreadBodySchema,
	parseCommentDecision,
	unreadQuerySchema,
} from '@maskin/shared'
import { and, desc, eq, inArray, max, ne, or, sql } from 'drizzle-orm'
import { createApiError, validationFailureHook } from '../lib/errors'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { markRead as markReadService, markUnread as markUnreadService } from '../services/subscriptions'

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

const unreadItemSchema = z.object({
	entity_type: z.string(),
	entity_id: z.string().uuid(),
	// Total unread activity count. For You only surfaces comments that actually
	// @-mention the current actor. The one exception is an onboarding_session
	// object visible to the workspace owner, whose coach replies count as
	// unread regardless of mention (the coach doesn't @-mention on every turn).
	unread_count: z.number(),
	// Count of unread events that actually @-mention the current actor. Equal to
	// unread_count for every entity except onboarding_session objects surfaced
	// via the owner carve-out.
	mentioning_unread_count: z.number(),
	// Highest attention score (1-5) among this entity's unread comments — same
	// join scope as unread_count. null when none of the unread comments carry
	// an attention score.
	max_unread_attention: z.number().nullable(),
	latest_event_id: z.number().nullable(),
	latest_activity_at: z.string().nullable(),
	object: objectResponseSchema.optional(),
	latest_mention: z
		.object({
			event_id: z.number(),
			actor_id: z.string().uuid().nullable(),
			created_at: z.string(),
			content: z.string(),
			attention: z.number().nullable(),
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
	const decision = parseCommentDecision(data.decision)

	return {
		event_id: Number(event.id),
		actor_id: event.actorId ?? null,
		created_at:
			event.createdAt instanceof Date ? event.createdAt.toISOString() : String(event.createdAt),
		content: rawContent,
		attention: Number.isFinite(attention) ? attention : null,
		decision,
	}
}

const unreadResponseSchema = z.object({
	items: z.array(unreadItemSchema),
})

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

// GET /api/subscriptions/unread — comments the actor should see, derived from
// `events` (no `subscriptions` table dependency).
//
// A row lands in the feed when at least one comment on the entity satisfies
// either predicate:
//   1. The comment @-mentions this actor (`events.data.mentions` contains the
//      actor id) — the default surfacing rule since the subscribe feature was
//      retired.
//   2. The entity is an `onboarding_session` object in the caller's workspace
//      AND the caller is a workspace owner (`workspace_members.role = 'owner'`
//      for this workspace_id + actor_id). The coach doesn't @-mention on every
//      onboarding turn, so this preserves what the retired coach-side
//      auto-subscribe used to guarantee. Widening to state: a workspace with
//      more than one owner will show onboarding comments to every owner, where
//      the pre-removal behaviour showed them only to the subscribed one.
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

	// Owner-scoped onboarding carve-out: is the CALLING actor a workspace owner
	// of THIS workspace? A single boolean lookup we splice into the SQL filter
	// so the query has one shape whether the caller is an owner or not — and
	// so a non-owner in the same workspace can never see onboarding comments
	// they weren't @-mentioned on.
	const [ownerRow] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(workspaceMembers.actorId, actorId),
				eq(workspaceMembers.role, 'owner'),
			),
		)
		.limit(1)
	const isCallerOwner = Boolean(ownerRow)

	// Per-actor high-water-mark for a given (entity_type, entity_id). Same
	// coalesce-to-0 shape as the retired subscription-driven query — a missing
	// read_state row means everything on the entity is unread.
	const lastReadExpr = sql<number>`coalesce(
		(select last_read_event_id from read_state
			where actor_id = ${actorId}
				and entity_type = ${events.entityType}
				and entity_id = ${events.entityId}),
		0
	)`

	// Row-level predicate: which `events` rows count as a signal to surface?
	// Both branches restrict to comments that (a) were not posted by the
	// viewer and (b) belong to the caller's workspace.
	// (1) @-mention branch: `data.mentions` contains this actor id.
	// (2) onboarding_session branch: entity is an onboarding_session object
	//     in this workspace AND the caller is an owner here. The
	//     workspace_id equality on the objects join is the "session's own
	//     workspace" guard the reviewer asked for — never a global owner
	//     check.
	const mentionsCaller = sql`${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)`
	const onboardingObjectPredicate = and(
		eq(events.entityType, 'object'),
		eq(objects.type, 'onboarding_session'),
		eq(objects.workspaceId, workspaceId),
	)
	const surfacePredicate = isCallerOwner
		? or(mentionsCaller, onboardingObjectPredicate)
		: mentionsCaller

	const conditions = [
		eq(events.workspaceId, workspaceId),
		eq(events.action, 'commented'),
		ne(events.actorId, actorId),
		surfacePredicate,
	]
	if (entity_type) conditions.push(eq(events.entityType, entity_type))

	// Windowing: unread events always join; when the caller opts in, keep
	// read events still within a 48h window so recently-read cards linger.
	// 48h covers the Today and Yesterday buckets the ForYouDashboard renders.
	const windowPredicate = includeRecentlyRead
		? sql`(${events.id} > ${lastReadExpr} or ${events.createdAt} >= now() - interval '48 hours')`
		: sql`${events.id} > ${lastReadExpr}`
	conditions.push(windowPredicate)

	// True unread count regardless of whether recently-read events are joined.
	const unreadCountExpr = sql<
		number
	>`coalesce(count(${events.id}) filter (where ${events.id} > ${lastReadExpr}), 0)::int`

	// Per-entity mention count over unread events only. Onboarding-only cards
	// (surfaced by predicate 2) can have unread_count > 0 while this stays 0.
	const mentioningUnreadCountExpr = sql<
		number
	>`coalesce(count(*) filter (where ${events.id} > ${lastReadExpr} and ${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)), 0)::int`

	// Highest attention (1-5) among unread comments; null when every unread
	// comment carries no attention score. Priority sort treats null as the
	// lowest tier.
	const maxUnreadAttentionExpr = sql<
		number | null
	>`max((${events.data}->>'attention')::int) filter (where ${events.id} > ${lastReadExpr})`

	// Newest event id in the join scope. For a mention-driven card this IS the
	// newest mentioning event (same predicate). For an onboarding-only card
	// it's whichever coach reply came latest — the card leads with that
	// comment's body rather than with the object's own title.
	const latestEventIdExpr = max(events.id)

	const rows = await db
		.select({
			entityType: events.entityType,
			entityId: events.entityId,
			unreadCount: unreadCountExpr,
			mentioningUnreadCount: mentioningUnreadCountExpr,
			maxUnreadAttention: maxUnreadAttentionExpr,
			latestEventId: latestEventIdExpr,
			latestActivityAt: max(events.createdAt),
		})
		.from(events)
		.leftJoin(objects, and(eq(events.entityType, 'object'), eq(objects.id, events.entityId)))
		.where(and(...conditions))
		.groupBy(events.entityType, events.entityId)
		.orderBy(desc(latestEventIdExpr))

	// Hydrate object summaries for entity_type='object'. Scoped to workspaceId
	// so a stale row pointing at a foreign object can never expose it cross-
	// workspace (belt and braces — the surface predicate already restricted
	// events by workspace).
	const objectIds = rows.filter((r) => r.entityType === 'object').map((r) => r.entityId)
	const objectsById = new Map<string, typeof objects.$inferSelect>()
	if (objectIds.length > 0) {
		const fetched = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
		for (const o of fetched) objectsById.set(o.id, o)
	}

	// Hydrate the latest surface-event's body for the card. `latest_event_id`
	// is exact by construction (see aggregate above). Deliberately a second
	// keyed query rather than a correlated subquery — Drizzle column objects
	// interpolated into a correlated `sql` template render unqualified and
	// bind to the wrong table (see .claude/rules/known-pitfalls.md).
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
