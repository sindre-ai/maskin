import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, readState } from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import {
	CLOSED_OBJECT_STATUSES,
	findFinishedDraftCards,
	loadVisibleForYou,
} from '../lib/for-you-visibility'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { feedDecisionSchema, fillDraftBodies, toLatestMention } from './subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/** Decision cards older than this are not live asks any more; the scan also stays bounded. */
const DECISION_WINDOW_DAYS = 14
const DECISION_SCAN_LIMIT = 300

const forYouItemSchema = z.object({
	// Null for a decision card, which comes straight from an agent's comment and has no
	// notification behind it.
	notification_id: z.string().uuid().nullable(),
	// `curated` is on the list because the Chief of Staff put it there; `decision` is a
	// decision card an agent addressed to this person directly.
	source: z.enum(['curated', 'decision']),
	rank: z.number(),
	// What marking the item read moves the person's read position to: the source comment, or
	// for a curated item with no comment the newest activity on its object. Null when the
	// object has no activity to mark.
	latest_event_id: z.number().nullable(),
	headline: z.string(),
	rationale: z.string().nullable(),
	created_at: z.string().nullable(),
	entity_type: z.literal('object').nullable(),
	entity_id: z.string().uuid().nullable(),
	session_id: z.string().uuid().nullable(),
	object: objectResponseSchema.optional(),
	latest_mention: z
		.object({
			event_id: z.number(),
			actor_id: z.string().uuid().nullable(),
			created_at: z.string(),
			content: z.string(),
			attention: z.number().nullable(),
			// With each draft's text and, for an email or message, its `preview`.
			decision: feedDecisionSchema.nullable(),
		})
		.optional(),
})

const forYouResponseSchema = z.object({ items: z.array(forYouItemSchema) })

const listForYouRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['For You'],
	summary:
		"What needs the current actor: the Chief of Staff's ranked list, then decision cards addressed to them",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Ranked For You items, already filtered against live state',
			content: { 'application/json': { schema: forYouResponseSchema } },
		},
		400: {
			description: 'Missing workspace ID',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listForYouRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const { cards, objectById, sourceById, newestEventByEntity } = await loadVisibleForYou(
		db,
		workspaceId,
		actorId,
	)

	const curatedItems = cards.map(({ row, meta }) => {
		const obj = row.objectId ? objectById.get(row.objectId) : undefined
		const source =
			meta.source_comment_id !== undefined ? sourceById.get(meta.source_comment_id) : undefined
		return {
			notification_id: row.id,
			source: 'curated' as const,
			rank: meta.rank,
			latest_event_id: source
				? Number(source.id)
				: row.objectId
					? (newestEventByEntity.get(row.objectId) ?? 0) || null
					: null,
			headline: meta.headline,
			rationale: meta.rationale ?? null,
			created_at: row.createdAt ? row.createdAt.toISOString() : null,
			entity_type: row.objectId ? ('object' as const) : null,
			entity_id: row.objectId ?? null,
			session_id: row.sessionId ?? null,
			...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
			...(source ? { latest_mention: toLatestMention(source) } : {}),
		}
	})

	// Decision cards: an agent asked this person for a call directly (a draft to approve, a
	// batch to send). They reach the list without the Chief of Staff, so a draft waiting on
	// someone never depends on an hourly run. Plain mentions do not: only a comment that
	// carries a decision block is a blocked ask.
	const curatedEntityIds = new Set(curatedItems.flatMap((i) => (i.entity_id ? [i.entity_id] : [])))
	const decisionRows = await db
		.select({ event: events })
		.from(events)
		.leftJoin(
			readState,
			and(
				eq(readState.workspaceId, events.workspaceId),
				eq(readState.actorId, actorId),
				eq(readState.entityType, 'object'),
				eq(readState.entityId, events.entityId),
			),
		)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
				eq(events.entityType, 'object'),
				ne(events.actorId, actorId),
				sql`${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)`,
				sql`jsonb_typeof(${events.data}->'decision') = 'object'`,
				sql`${events.createdAt} >= now() - make_interval(days => ${DECISION_WINDOW_DAYS})`,
				gt(events.id, sql`coalesce(${readState.lastReadEventId}, 0)`),
			),
		)
		.orderBy(desc(events.id))
		.limit(DECISION_SCAN_LIMIT)

	// Newest decision per object; the rows arrive newest first.
	const latestDecisionByEntity = new Map<string, typeof events.$inferSelect>()
	for (const { event } of decisionRows) {
		if (curatedEntityIds.has(event.entityId)) continue
		if (!latestDecisionByEntity.has(event.entityId))
			latestDecisionByEntity.set(event.entityId, event)
	}

	const decisionEntityIds = [...latestDecisionByEntity.keys()]
	const [decisionObjects, decisionReplies] = decisionEntityIds.length
		? await Promise.all([
				db
					.select()
					.from(objects)
					.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, decisionEntityIds))),
				db
					.select({ entityId: events.entityId, id: events.id })
					.from(events)
					.where(
						and(
							eq(events.workspaceId, workspaceId),
							eq(events.action, 'commented'),
							eq(events.actorId, actorId),
							inArray(events.entityId, decisionEntityIds),
							gt(
								events.id,
								Math.min(...[...latestDecisionByEntity.values()].map((e) => Number(e.id))),
							),
						),
					),
			])
		: [[], []]
	const decisionObjectById = new Map(decisionObjects.map((o) => [o.id, o]))

	const finishedDraftCards = await findFinishedDraftCards(db, workspaceId, [
		...latestDecisionByEntity.values(),
	])
	const liveDecisions = [...latestDecisionByEntity.values()].filter((event) => {
		const obj = decisionObjectById.get(event.entityId)
		// Gone or closed (done, discarded, shipped…): the card would only ask about finished work.
		if (!obj || CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return false
		// Every message it offered has been sent or skipped.
		if (finishedDraftCards.has(Number(event.id))) return false
		// The person already answered on this thread.
		return !decisionReplies.some((r) => r.entityId === event.entityId && r.id > event.id)
	})

	const rankBase = curatedItems.reduce((max, i) => Math.max(max, i.rank), 0)
	const decisionItems = liveDecisions.map((event, index) => {
		const mention = toLatestMention(event)
		const obj = decisionObjectById.get(event.entityId)
		return {
			notification_id: null,
			source: 'decision' as const,
			rank: rankBase + 1 + index,
			latest_event_id: mention.event_id,
			headline: mention.decision?.title ?? 'Needs your call',
			rationale: null,
			created_at: mention.created_at,
			entity_type: 'object' as const,
			entity_id: event.entityId,
			session_id: null,
			...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
			latest_mention: mention,
		}
	})

	const items = [...curatedItems, ...decisionItems]

	// Drafts show the object's description as it is now, not as it was when the card was posted.
	await fillDraftBodies(
		db,
		workspaceId,
		items.flatMap((i) => (i.latest_mention ? [i.latest_mention] : [])),
		new Map([...objectById, ...decisionObjectById]),
	)

	return c.json({ items }, 200)
})

export default app
