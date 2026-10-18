import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, notifications, objects, readState, sessions } from '@maskin/db/schema'
import { FOR_YOU_KIND, commentDecisionSchema, parseForYouMetadata } from '@maskin/shared'
import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { validationFailureHook } from '../lib/errors'
import { errorSchema, objectResponseSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
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
	notification_id: z.string().uuid(),
	rank: z.number(),
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
	if (candidates.length === 0) return c.json({ items: [] }, 200)

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
			const sessionStatus = row.sessionId ? sessionStatusById.get(row.sessionId) : undefined
			if (sessionStatus && (TERMINAL_STATUSES as readonly string[]).includes(sessionStatus)) {
				return false
			}
			if (row.objectId) {
				const obj = objectById.get(row.objectId)
				// Deleted (FK set null would have cleared it) or closed: nothing left to decide.
				if (!obj || CLOSED_OBJECT_STATUSES.includes(obj.status ?? '')) return false
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
			}
		})

	return c.json({ items }, 200)
})

export default app
