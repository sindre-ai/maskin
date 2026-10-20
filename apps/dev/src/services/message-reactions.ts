import type { Database } from '@maskin/db'
import { actors, messageReactions } from '@maskin/db/schema'
import { asc, eq, inArray } from 'drizzle-orm'

export type MessageReaction = {
	emoji: string
	count: number
	reactedByMe: boolean
	actors: { actorId: string; actorName: string }[]
}

/** Reactions for a page of messages, grouped by emoji in first-used order. */
export async function loadReactionsByMessage(
	db: Database,
	callerId: string,
	messageIds: number[],
): Promise<Map<number, MessageReaction[]>> {
	const out = new Map<number, MessageReaction[]>()
	if (messageIds.length === 0) return out
	const rows = await db
		.select({
			messageId: messageReactions.messageId,
			emoji: messageReactions.emoji,
			actorId: actors.id,
			actorName: actors.name,
		})
		.from(messageReactions)
		.innerJoin(actors, eq(actors.id, messageReactions.actorId))
		.where(inArray(messageReactions.messageId, messageIds))
		.orderBy(asc(messageReactions.createdAt), asc(messageReactions.actorId))
	for (const r of rows) {
		const list = out.get(r.messageId) ?? []
		let group = list.find((g) => g.emoji === r.emoji)
		if (!group) {
			group = { emoji: r.emoji, count: 0, reactedByMe: false, actors: [] }
			list.push(group)
		}
		group.count += 1
		group.actors.push({ actorId: r.actorId, actorName: r.actorName })
		if (r.actorId === callerId) group.reactedByMe = true
		out.set(r.messageId, list)
	}
	return out
}
