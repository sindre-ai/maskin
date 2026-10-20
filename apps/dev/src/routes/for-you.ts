import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, notifications, objects, readState, sessions } from '@maskin/db/schema'
import { FOR_YOU_KIND, commentDecisionSchema, parseForYouMetadata } from '@maskin/shared'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import {
	decisionFeedItemSchema,
	errorSchema,
	objectResponseSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { loadDecisionFeed } from '../services/message-decisions'
import { TERMINAL_STATUSES } from '../services/session-lifecycle'
import { toLatestMention } from './subscriptions'

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/**
 * Object statuses after which an ask about the object no longer needs anyone.
 * Workspace statuses are configurable, so this is the union of the closed
 * states the built-in object types use.
 */
const CLOSED_OBJECT_STATUSES = [
	'done',
	'completed',
	'succeeded',
	'failed',
	'cancelled',
	'canceled',
	'closed',
	'archived',
	'shipped',
	'dismissed',
]

const forYouItemSchema = z.object({
	/** Null for a decision card that showed up on its own, before anyone ranked it. */
	notification_id: z.string().uuid().nullable(),
	/** Null until the Chief of Staff ranks the item; unranked cards follow the ranked ones. */
	rank: z.number().nullable(),
	headline: z.string(),
	rationale: z.string().nullable(),
	created_at: z.string().nullable(),
	entity_type: z.literal('object').nullable(),
	entity_id: z.string().uuid().nullable(),
	session_id: z.string().uuid().nullable(),
	object: objectResponseSchema.optional(),
	/** Set when the item is a decision card in a chat: answer it in place, or open its thread. */
	chat_decision: decisionFeedItemSchema.optional(),
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

const forYouResponseSchema = z.object({ items: z.array(forYouItemSchema) })

const listForYouRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['For You'],
	summary: "The Chief of Staff's ranked list of what needs the current actor",
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

	const rows = await db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.workspaceId, workspaceId),
				eq(notifications.targetActorId, actorId),
				eq(notifications.type, 'needs_input'),
				inArray(notifications.status, ['pending', 'seen']),
				sql`${notifications.metadata}->>'kind' = ${FOR_YOU_KIND}`,
			),
		)

	const candidates = rows.flatMap((row) => {
		const meta = parseForYouMetadata(row.metadata)
		return meta ? [{ row, meta }] : []
	})

	// Decision cards in chats that are addressed to the caller and still open. They reach the list
	// on their own, so nobody has to go looking for them in a chat; a ranked item that points at
	// one just gives it a headline, a reason and a place in the order.
	const decisionCards = await loadDecisionFeed(db, {
		workspaceId,
		callerId: actorId,
		state: 'open',
		scope: 'mine',
		limit: 100,
	})
	const decisionByMessage = new Map(decisionCards.map((d) => [d.message_id, d]))

	const objectIds = [
		...new Set(candidates.flatMap((x) => (x.row.objectId ? [x.row.objectId] : []))),
	]
	const sessionIds = [
		...new Set(candidates.flatMap((x) => (x.row.sessionId ? [x.row.sessionId] : []))),
	]

	const [objectRows, sessionRows, readRows] = await Promise.all([
		objectIds.length
			? db
					.select()
					.from(objects)
					.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, objectIds)))
			: [],
		sessionIds.length
			? db
					.select({ id: sessions.id, status: sessions.status })
					.from(sessions)
					.where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.id, sessionIds)))
			: [],
		objectIds.length
			? db
					.select({ entityId: readState.entityId, lastReadEventId: readState.lastReadEventId })
					.from(readState)
					.where(
						and(
							eq(readState.workspaceId, workspaceId),
							eq(readState.actorId, actorId),
							eq(readState.entityType, 'object'),
							inArray(readState.entityId, objectIds),
						),
					)
			: [],
	])
	const objectById = new Map(objectRows.map((o) => [o.id, o]))
	const sessionStatusById = new Map(sessionRows.map((s) => [s.id, s.status]))
	const lastReadByEntity = new Map(readRows.map((r) => [r.entityId, r.lastReadEventId]))

	// Source comments, and any reply by the viewer after them, in two queries.
	const sourceIds = candidates.flatMap((x) =>
		x.meta.source_comment_id !== undefined ? [x.meta.source_comment_id] : [],
	)
	const sourceRows = sourceIds.length
		? await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, workspaceId), inArray(events.id, sourceIds)))
		: []
	const sourceById = new Map(sourceRows.map((e) => [e.id, e]))

	const replyRows = objectIds.length
		? await db
				.select({ entityId: events.entityId, id: events.id })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.action, 'commented'),
						eq(events.actorId, actorId),
						inArray(events.entityId, objectIds),
						gt(events.id, Math.min(...sourceIds, Number.MAX_SAFE_INTEGER)),
					),
				)
		: []

	const items = candidates
		.filter(({ row, meta }) => {
			// An ask about a decision card is moot once the card is answered, withdrawn, or no longer
			// addressed to this person.
			if (
				meta.source_decision_message_id !== undefined &&
				!decisionByMessage.has(meta.source_decision_message_id)
			) {
				return false
			}
			const sessionStatus = row.sessionId ? sessionStatusById.get(row.sessionId) : undefined
			if (sessionStatus && (TERMINAL_STATUSES as readonly string[]).includes(sessionStatus)) {
				return false
			}
			if (row.objectId) {
				const obj = objectById.get(row.objectId)
				// Deleted (FK set null would have cleared it) or closed: nothing left to decide.
				if (!obj || CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return false
				// The ask names the state it assumed ("move to active" assumes "proposed").
				// Once the object is anywhere else, the ask is already moot.
				if (meta.only_while_status && !meta.only_while_status.includes(obj.status ?? '')) {
					return false
				}
				const sourceId = meta.source_comment_id
				if (sourceId !== undefined) {
					const lastRead = lastReadByEntity.get(row.objectId) ?? 0
					if (lastRead >= sourceId) return false
					if (replyRows.some((r) => r.entityId === row.objectId && r.id > sourceId)) return false
				}
			}
			return true
		})
		.sort(
			(a, b) =>
				a.meta.rank - b.meta.rank ||
				(b.row.createdAt?.getTime() ?? 0) - (a.row.createdAt?.getTime() ?? 0),
		)
		.map(({ row, meta }) => {
			const obj = row.objectId ? objectById.get(row.objectId) : undefined
			const source =
				meta.source_comment_id !== undefined ? sourceById.get(meta.source_comment_id) : undefined
			const card =
				meta.source_decision_message_id !== undefined
					? decisionByMessage.get(meta.source_decision_message_id)
					: undefined
			return {
				notification_id: row.id,
				rank: meta.rank,
				headline: meta.headline,
				rationale: meta.rationale ?? null,
				created_at: row.createdAt ? row.createdAt.toISOString() : null,
				entity_type: row.objectId ? ('object' as const) : null,
				entity_id: row.objectId ?? null,
				session_id: row.sessionId ?? null,
				...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
				...(source ? { latest_mention: toLatestMention(source) } : {}),
				...(card ? { chat_decision: card } : {}),
			}
		})

	// Cards nobody has ranked yet follow the ranked items, most urgent first.
	const ranked = new Set(
		items.flatMap((i) => (i.chat_decision ? [i.chat_decision.message_id] : [])),
	)
	const unranked = decisionCards.filter((d) => !ranked.has(d.message_id))
	const unrankedObjectIds = [
		...new Set(
			unranked.flatMap((d) => (d.object_id && !objectById.has(d.object_id) ? [d.object_id] : [])),
		),
	]
	if (unrankedObjectIds.length > 0) {
		const more = await db
			.select()
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, unrankedObjectIds)))
		for (const o of more) objectById.set(o.id, o)
	}
	const automatic = unranked.flatMap((d) => {
		const obj = d.object_id ? objectById.get(d.object_id) : undefined
		// The task the card is about is already closed: nothing left to decide.
		if (obj && CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return []
		return [
			{
				notification_id: null,
				rank: null,
				headline: d.decision.title,
				rationale: null,
				created_at: d.created_at,
				entity_type: d.object_id ? ('object' as const) : null,
				entity_id: d.object_id,
				session_id: null,
				...(obj ? { object: serialize(obj) as z.infer<typeof objectResponseSchema> } : {}),
				chat_decision: d,
			},
		]
	})

	return c.json({ items: [...items, ...automatic] }, 200)
})

export default app
