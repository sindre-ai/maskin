import type { Database } from '@maskin/db'
import { conversationParticipants, conversations } from '@maskin/db/schema'
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm'
import { unreadChatCondition } from '../services/chat-unread'
import { buildForYouItems } from './for-you-items'

// How many workspaces' For You lists are built at once. A person is in a handful of
// workspaces, so this only keeps a large account from opening a burst of queries.
const FOR_YOU_CONCURRENCY = 4

/**
 * Unread chats per workspace for one person, in a single grouped query over every workspace
 * asked about. Counts chats, not messages, with the same rule the Chats list uses for its
 * unread filter (unreadChatCondition): still a participant, not archived, and an unread mention
 * or an open card for the person, or a new message in a direct chat with an agent. Workspaces
 * with no unread chat are left out of the map.
 */
export async function loadUnreadChatCounts(
	db: Database,
	actorId: string,
	workspaceIds: string[],
): Promise<Map<string, number>> {
	if (workspaceIds.length === 0) return new Map()
	const rows = await db
		.select({ workspaceId: conversations.workspaceId, total: count() })
		.from(conversationParticipants)
		.innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
		.where(
			and(
				eq(conversationParticipants.actorId, actorId),
				isNull(conversationParticipants.leftAt),
				eq(conversationParticipants.archived, false),
				inArray(conversations.workspaceId, workspaceIds),
				unreadChatCondition({
					callerId: actorId,
					conversationId: sql`conversation_participants.conversation_id`,
					lastRead: sql`conversation_participants.last_read_message_id`,
				}),
			),
		)
		.groupBy(conversations.workspaceId)
	return new Map(rows.map((r) => [r.workspaceId, Number(r.total)]))
}

/**
 * How many For You items wait on one person in each workspace. It reuses buildForYouItems, the
 * one function behind the For You page, so this number can never drift from the badge the
 * person sees once they open that workspace. Workspaces with nothing waiting are left out.
 */
export async function loadForYouCounts(
	db: Database,
	actorId: string,
	workspaceIds: string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>()
	for (let i = 0; i < workspaceIds.length; i += FOR_YOU_CONCURRENCY) {
		const batch = workspaceIds.slice(i, i + FOR_YOU_CONCURRENCY)
		const items = await Promise.all(batch.map((id) => buildForYouItems(db, id, actorId)))
		batch.forEach((id, index) => {
			const waiting = items[index]?.length ?? 0
			if (waiting > 0) counts.set(id, waiting)
		})
	}
	return counts
}
