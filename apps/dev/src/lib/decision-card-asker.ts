import type { Database } from '@maskin/db'
import { events, actors } from '@maskin/db/schema'
import { and, desc, eq, or, sql } from 'drizzle-orm'

/**
 * The agent that asked the decision card a person is answering, or null when the thread holds no
 * card from an agent. `threadRootEventId` is the root comment of the thread the answer was posted
 * in. The card is the newest comment in that thread with a decision block, the root itself or a
 * reply to it, so an answer to a card posted later in a thread still reaches the agent that asked.
 *
 * A person's answer starts only this agent (bet "Flows that run like development", rule 7): not the
 * object's driver, not the Chief of Staff, not the other agents earlier in the thread.
 */
export async function findDecisionCardAsker(
	db: Database,
	ctx: { workspaceId: string; objectId: string; threadRootEventId: number },
): Promise<string | null> {
	const [card] = await db
		.select({ actorId: events.actorId })
		.from(events)
		.innerJoin(actors, and(eq(actors.id, events.actorId), eq(actors.type, 'agent')))
		.where(
			and(
				eq(events.workspaceId, ctx.workspaceId),
				eq(events.entityType, 'object'),
				eq(events.entityId, ctx.objectId),
				eq(events.action, 'commented'),
				sql`${events.data}->'decision' IS NOT NULL`,
				or(
					eq(events.id, ctx.threadRootEventId),
					sql`${events.data}->>'parentEventId' = ${String(ctx.threadRootEventId)}`,
				),
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	return card?.actorId ?? null
}
