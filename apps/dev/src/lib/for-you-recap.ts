import { z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, actors, objects } from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, lte, ne, sql } from 'drizzle-orm'

/** The recap never reaches back further than this, however old the since time is. */
export const RECAP_WINDOW_DAYS = 7
/** A card is only counted as answered while it is still a live ask. Matches the For You list. */
const DECISION_WINDOW_DAYS = 14
/** Named items per section. The count is the full figure; the list is only a sample. */
export const RECAP_ITEM_CAP = 5

const countedSchema = <T extends z.ZodTypeAny>(item: T) =>
	z.object({ count: z.number().int().nonnegative(), items: z.array(item) })

export const forYouRecapSchema = z.object({
	since: z.string().describe('The start of the window actually used, after the 7 day cap.'),
	asks_answered: countedSchema(
		z.object({
			object_id: z.string().uuid(),
			comment_id: z.number().describe("The decision card's comment id."),
			answered_by: z.string().uuid(),
		}),
	).describe('Decision cards addressed to the person that someone else has replied to.'),
	items_moved: countedSchema(
		z.object({
			object_id: z.string().uuid(),
			type: z.string(),
			title: z.string(),
			status: z.string().describe('Where the item is now.'),
		}),
	).describe(
		'Insights, bets and tasks that changed status, not counting the ones the person moved.',
	),
	agents_finished: countedSchema(
		z.object({
			agent_id: z.string().uuid(),
			name: z.string(),
			sessions: z.number().int().positive(),
		}),
	).describe('Agents with a session that completed. count is the number of agents.'),
})

export type ForYouRecap = z.infer<typeof forYouRecapSchema>

/**
 * What changed in a workspace since a person last looked, as facts the app turns into a
 * sentence. Read from the events log, so there is no table and no stored text. The person's
 * own actions are left out, nothing older than seven days is read, and an event from another
 * workspace never matches. A person with nothing new gets zero counts and empty lists.
 */
export async function buildForYouRecap(
	db: Database,
	workspaceId: string,
	actorId: string,
	since: Date,
	now: Date = new Date(),
): Promise<ForYouRecap> {
	const floor = new Date(now.getTime() - RECAP_WINDOW_DAYS * 24 * 60 * 60 * 1000)
	const from = since.getTime() > floor.getTime() ? since : floor
	const inWindow = and(
		eq(events.workspaceId, workspaceId),
		ne(events.actorId, actorId),
		gt(events.createdAt, from),
		lte(events.createdAt, now),
	)

	const [moved, finished, answered] = await Promise.all([
		movedItems(db, workspaceId, inWindow),
		finishedAgents(db, inWindow),
		answeredAsks(db, workspaceId, actorId, from, now),
	])

	return {
		since: from.toISOString(),
		asks_answered: answered,
		items_moved: moved,
		agents_finished: finished,
	}
}

type Window = ReturnType<typeof and>

async function movedItems(db: Database, workspaceId: string, inWindow: Window) {
	// One row per item, newest move first. The window count gives the full figure past the cap.
	const latest = await db
		.select({
			entityId: events.entityId,
			lastEventId: sql<number>`max(${events.id})`.as('last_event_id'),
			total: sql<number>`count(*) over ()`.mapWith(Number),
		})
		.from(events)
		.where(and(inWindow, eq(events.entityType, 'object'), eq(events.action, 'status_changed')))
		.groupBy(events.entityId)
		.orderBy(desc(sql`max(${events.id})`))
		.limit(RECAP_ITEM_CAP)

	if (latest.length === 0) return { count: 0, items: [] }

	const rows = await db
		.select({ id: objects.id, type: objects.type, title: objects.title, status: objects.status })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				inArray(
					objects.id,
					latest.map((l) => l.entityId),
				),
			),
		)
	const byId = new Map(rows.map((r) => [r.id, r]))
	const items = latest.flatMap((l) => {
		const o = byId.get(l.entityId)
		return o ? [{ object_id: o.id, type: o.type, title: o.title ?? '', status: o.status }] : []
	})
	return { count: latest[0]?.total ?? 0, items }
}

async function finishedAgents(db: Database, inWindow: Window) {
	const rows = await db
		.select({
			agentId: events.actorId,
			name: actors.name,
			sessions: sql<number>`count(*)`.mapWith(Number),
			total: sql<number>`count(*) over ()`.mapWith(Number),
		})
		.from(events)
		.innerJoin(actors, eq(actors.id, events.actorId))
		.where(
			and(
				inWindow,
				eq(events.entityType, 'session'),
				eq(events.action, 'session_completed'),
				eq(actors.type, 'agent'),
			),
		)
		.groupBy(events.actorId, actors.name)
		.orderBy(desc(sql`count(*)`), actors.name)
		.limit(RECAP_ITEM_CAP)

	return {
		count: rows[0]?.total ?? 0,
		items: rows.map((r) => ({ agent_id: r.agentId, name: r.name, sessions: r.sessions })),
	}
}

/**
 * Decision cards addressed to the person that another person has since replied to. A reply
 * is a threaded comment, and the server stores every reply against the root of its thread, so
 * a reply's parent is the card. Agents replying on their own card do not count as an answer.
 */
async function answeredAsks(
	db: Database,
	workspaceId: string,
	actorId: string,
	from: Date,
	now: Date,
) {
	const cardFloor = new Date(now.getTime() - DECISION_WINDOW_DAYS * 24 * 60 * 60 * 1000)
	const rows = await db.execute<{
		comment_id: string
		object_id: string
		answered_by: string
	}>(sql`
		SELECT DISTINCT ON (card.id)
			card.id AS comment_id,
			card.entity_id AS object_id,
			reply.actor_id AS answered_by
		FROM events card
		JOIN events reply
			ON reply.workspace_id = card.workspace_id
			AND reply.action = 'commented'
			AND reply.id > card.id
			AND reply.data ->> 'parentEventId' = card.id::text
		JOIN actors replier ON replier.id = reply.actor_id AND replier.type = 'human'
		WHERE card.workspace_id = ${workspaceId}
			AND card.action = 'commented'
			AND card.entity_type = 'object'
			AND card.created_at > ${cardFloor.toISOString()}
			AND card.data -> 'decision' IS NOT NULL
			AND card.data -> 'mentions' @> ${JSON.stringify([actorId])}::jsonb
			AND reply.actor_id <> ${actorId}
			AND reply.created_at > ${from.toISOString()}
			AND reply.created_at <= ${now.toISOString()}
		ORDER BY card.id DESC, reply.id ASC
	`)

	const all = Array.from(rows)
	return {
		count: all.length,
		items: all.slice(0, RECAP_ITEM_CAP).map((r) => ({
			object_id: r.object_id,
			comment_id: Number(r.comment_id),
			answered_by: r.answered_by,
		})),
	}
}
