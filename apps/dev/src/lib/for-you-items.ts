import { z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects } from '@maskin/db/schema'
import { parseCommentDecision } from '@maskin/shared'
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import { feedDecisionSchema, fillDraftBodies, toLatestMention } from '../routes/subscriptions'
import { dueAtOf } from '../services/push-policy'
import {
	CLOSED_OBJECT_STATUSES,
	findDismissedSourceIds,
	findFinishedDraftCards,
	findViewerReplies,
	isCardAnswered,
	loadVisibleForYou,
} from './for-you-visibility'
import { objectResponseSchema } from './openapi-schemas'
import { serialize } from './serialize'

/** Decision cards older than this are not live asks any more; the scan also stays bounded. */
const DECISION_WINDOW_DAYS = 14
const DECISION_SCAN_LIMIT = 300

export const forYouItemSchema = z.object({
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
	// When the person must decide by (ISO time the Chief of Staff set as metadata.due_at); null
	// when the card does not expire.
	due_at: z.string().nullable(),
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

export type ForYouItem = z.infer<typeof forYouItemSchema>

/**
 * The list `GET /api/for-you` returns for one actor: the Chief of Staff's curated cards that are
 * still live, then the decision cards agents addressed to the actor. The route and every other
 * reader of "what needs this person" call this one function, so no reader can drift from the web.
 */
export async function buildForYouItems(
	db: Database,
	workspaceId: string,
	actorId: string,
): Promise<ForYouItem[]> {
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
			due_at: dueAtOf((row.metadata ?? {}) as Record<string, unknown>)?.toISOString() ?? null,
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
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.action, 'commented'),
				eq(events.entityType, 'object'),
				ne(events.actorId, actorId),
				sql`${events.data}->'mentions' @> jsonb_build_array(${actorId}::text)`,
				sql`jsonb_typeof(${events.data}->'decision') = 'object'`,
				sql`${events.createdAt} >= now() - make_interval(days => ${DECISION_WINDOW_DAYS})`,
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
	const decisionIds = [...latestDecisionByEntity.values()].map((e) => Number(e.id))
	const [decisionObjects, viewerReplies, dismissedIds] = decisionEntityIds.length
		? await Promise.all([
				db
					.select()
					.from(objects)
					.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, decisionEntityIds))),
				findViewerReplies(db, workspaceId, actorId, decisionEntityIds, Math.min(...decisionIds)),
				findDismissedSourceIds(db, workspaceId, actorId, decisionIds),
			])
		: [[], [], new Set<number>()]
	const decisionObjectById = new Map(decisionObjects.map((o) => [o.id, o]))

	const finishedDraftCards = await findFinishedDraftCards(db, workspaceId, [
		...latestDecisionByEntity.values(),
	])
	const liveDecisions = [...latestDecisionByEntity.values()].filter((event) => {
		const obj = decisionObjectById.get(event.entityId)
		// Gone or closed (done, discarded, shipped…): the card would only ask about finished work.
		if (!obj || CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return false
		// The ask names the state it assumed ("flip to active" assumes "define"). Once the object
		// is anywhere else the ask is moot, the same rule curated cards already follow.
		const assumed = parseCommentDecision(
			(event.data as { decision?: unknown } | null)?.decision,
		)?.only_while_status
		if (assumed && !assumed.includes(obj.status ?? '')) return false
		// Every message it offered has been sent or skipped.
		if (finishedDraftCards.has(Number(event.id))) return false
		// The person answered this card with a threaded reply (an option tap is one), or
		// dismissed it. Reading the object or commenting elsewhere on it does neither.
		return !isCardAnswered(event, viewerReplies) && !dismissedIds.has(Number(event.id))
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
			due_at: null,
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

	return items
}
