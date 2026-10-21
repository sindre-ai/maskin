import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, notifications, objects, readState, sessions } from '@maskin/db/schema'
import { FOR_YOU_KIND, parseForYouMetadata } from '@maskin/shared'
import { and, desc, eq, gt, inArray, lte, max, ne, sql } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { TERMINAL_STATUSES } from '../services/session-lifecycle'
import { feedDecisionSchema, fillDraftBodies, toLatestMention } from './subscriptions'

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
	'discarded',
	'rejected',
]

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

	// A curated item with no source comment cannot be retired by answering a comment. It
	// counts as handled once the person has read its object past everything that existed
	// when the Chief of Staff listed it; later activity does not bring it back.
	const noSource = candidates.filter(
		({ row, meta }) => row.objectId && meta.source_comment_id === undefined,
	)
	const baselineByNotification = new Map<string, number>()
	await Promise.all(
		noSource.map(async ({ row }) => {
			const [found] = await db
				.select({ id: max(events.id) })
				.from(events)
				.where(
					and(
						eq(events.workspaceId, workspaceId),
						eq(events.entityId, row.objectId as string),
						row.createdAt ? lte(events.createdAt, row.createdAt) : undefined,
					),
				)
			baselineByNotification.set(row.id, Number(found?.id ?? 0))
		}),
	)
	const newestEventByEntity = new Map<string, number>()
	if (noSource.length > 0) {
		const newest = await db
			.select({ entityId: events.entityId, id: max(events.id) })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					inArray(
						events.entityId,
						noSource.map(({ row }) => row.objectId as string),
					),
				),
			)
			.groupBy(events.entityId)
		for (const r of newest) newestEventByEntity.set(r.entityId, Number(r.id ?? 0))
	}

	const curatedItems = candidates
		.filter(({ row, meta }) => {
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
				} else {
					const baseline = baselineByNotification.get(row.id) ?? 0
					const lastRead = lastReadByEntity.get(row.objectId) ?? 0
					if (baseline > 0 && lastRead >= baseline) return false
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

	const liveDecisions = [...latestDecisionByEntity.values()].filter((event) => {
		const obj = decisionObjectById.get(event.entityId)
		// Gone or closed (done, discarded, shipped…): the card would only ask about finished work.
		if (!obj || CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return false
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
