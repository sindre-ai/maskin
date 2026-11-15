import type { Database } from '@maskin/db'
import { conversationParticipants, messages, notifications } from '@maskin/db/schema'
import { REQUEST_CARD_METADATA_KEYS } from '@maskin/shared'
import { type SQL, and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import { isRequestCard, notAnswered } from './card-resolution'
import { previewText } from './chat-notifications'

/**
 * What waits on a person in their chats, in one place.
 *
 * A chat counts as unread for a person when it holds an unread mention of them or an open card
 * for them. Plain new messages do not count, so a busy agent chat no longer lights up the list.
 * The one exception is a direct chat with an agent, where every new message still counts.
 *
 * Mention: a message from someone else after the person's read marker whose metadata.mentions
 * holds their id.
 *
 * Open card for the person, from this chat, newer than OPEN_CARD_MAX_AGE_DAYS:
 * - a question an agent asked them here (a needs_input notification the ask route made with this
 *   chat's id, still pending or seen; answering in the chat resolves it), or
 * - a request card in the chat (a key, an access, an MCP server or a computer asked for) that
 *   nobody has answered, from someone else.
 * Cards from scheduled or flow sessions carry no chat id, so they stay in For You only.
 *
 * The same rule is written twice on purpose. The SQL fragments below are for filters that have to
 * decide per chat inside a larger query (list filters, workspace counts, search). loadChatSignals
 * is for the rows of one page, where the numbers and the one line of card text are needed.
 * Both read the same constants; chat-unread.test.ts runs them against the same chats.
 */

/** Cards older than this do not count as waiting. ASSUMED cutoff, one place to change it. */
export const OPEN_CARD_MAX_AGE_DAYS = 14

const DAY_MS = 86_400_000

const cardCutoff = () => new Date(Date.now() - OPEN_CARD_MAX_AGE_DAYS * DAY_MS)

export type ChatSignals = {
	/** Unread messages that mention the person. */
	mentionsUnread: number
	/** Open cards for the person in this chat. */
	openCards: number
	/** One line about the newest open card, or null when there is none. */
	cardText: string | null
	/** The one badge number: mentions plus open cards, or every unread message in an agent DM. */
	unreadCount: number
}

type Scope = {
	callerId: string
	/** SQL for the chat id, for example sql`conversations.id`. */
	conversationId: SQL
	/** SQL for the person's read marker on this chat, for example sql`conversation_participants.last_read_message_id`. */
	lastRead: SQL
}

// Table names (not Drizzle column refs) inside the subqueries: a column object inside a correlated
// subquery renders unqualified and binds to the inner table (known-pitfalls.md).

/** An unread message from someone else that mentions the person. */
export function unreadMentionExists({ callerId, conversationId, lastRead }: Scope): SQL {
	return sql`EXISTS (
		SELECT 1 FROM messages mu
		WHERE mu.conversation_id = ${conversationId}
			AND mu.actor_id <> ${callerId}
			AND mu.id > COALESCE(${lastRead}, 0)
			AND mu.metadata->'mentions' @> jsonb_build_array(${callerId}::text)
	)`
}

/** An open card for the person in this chat: an unanswered question, or an unanswered request card. */
export function openCardExists({ callerId, conversationId }: Scope): SQL {
	const age = sql.raw(String(OPEN_CARD_MAX_AGE_DAYS))
	const requestKinds = sql.join(
		REQUEST_CARD_METADATA_KEYS.map((key) => sql`(cu.metadata -> ${key}::text) IS NOT NULL`),
		sql` OR `,
	)
	return sql`(
		EXISTS (
			SELECT 1 FROM notifications nu
			WHERE nu.target_actor_id = ${callerId}
				AND nu.type = 'needs_input'
				AND nu.status IN ('pending', 'seen')
				AND nu.metadata->>'push_category' = 'needs_you'
				AND nu.metadata->>'conversation_id' = (${conversationId})::text
				AND nu.created_at > now() - interval '${age} days'
		)
		OR EXISTS (
			SELECT 1 FROM messages cu
			WHERE cu.conversation_id = ${conversationId}
				AND cu.actor_id <> ${callerId}
				AND cu.created_at > now() - interval '${age} days'
				AND (cu.metadata -> 'card_resolved') IS NULL
				AND (${requestKinds})
		)
	)`
}

/** An unread mention or an open card: what the Waiting on you view lists. */
export function waitingOnYouCondition(scope: Scope): SQL {
	return sql`(${unreadMentionExists(scope)} OR ${openCardExists(scope)})`
}

/** A direct chat that has an agent in it: the one kind of chat where every new message counts. */
function agentDirectChat({ conversationId }: Scope): SQL {
	return sql`EXISTS (
		SELECT 1 FROM conversations ud
		WHERE ud.id = ${conversationId}
			AND ud.direct_pair_key IS NOT NULL
			AND EXISTS (
				SELECT 1 FROM conversation_participants udp
				INNER JOIN actors uda ON uda.id = udp.actor_id
				WHERE udp.conversation_id = ud.id AND udp.left_at IS NULL AND uda.type = 'agent'
			)
	)`
}

/** Any new message from someone else after the read marker. */
function anyUnreadMessage({ callerId, conversationId, lastRead }: Scope): SQL {
	return sql`EXISTS (
		SELECT 1 FROM messages um
		WHERE um.conversation_id = ${conversationId}
			AND um.actor_id <> ${callerId}
			AND um.id > COALESCE(${lastRead}, 0)
	)`
}

/**
 * The chat is unread for the person. Everything that used to ask "is there a new message" asks
 * this instead: the list's unread filter and its priority scope, the quiet rules, the per-workspace
 * unread chat count and the unread status in search.
 */
export function unreadChatCondition(scope: Scope): SQL {
	return sql`(
		(${agentDirectChat(scope)} AND ${anyUnreadMessage(scope)})
		OR ${waitingOnYouCondition(scope)}
	)`
}

/**
 * The numbers for the rows of one page. Every id in `conversationIds` gets an entry, zeros
 * included. The caller has to be a participant of the chats it passes (the list and the detail
 * routes already filter on that); a chat the caller is not in comes back with zeros.
 */
export async function loadChatSignals(
	db: Database,
	callerId: string,
	conversationIds: string[],
): Promise<Map<string, ChatSignals>> {
	const result = new Map<string, ChatSignals>()
	if (conversationIds.length === 0) return result
	for (const id of conversationIds) {
		result.set(id, { mentionsUnread: 0, openCards: 0, cardText: null, unreadCount: 0 })
	}
	const cutoff = cardCutoff()

	const [unreadRows, questionRows, requestCardRows] = await Promise.all([
		db
			.select({
				conversationId: messages.conversationId,
				unread: sql<number>`count(*)::int`,
				mentions: sql<number>`(count(*) FILTER (WHERE ${messages.metadata}->'mentions' @> jsonb_build_array(${callerId}::text)))::int`,
				// A direct chat with an agent, where every new message counts. Worked out here, in the
				// same query, so the list needs no extra round trip for it. Only chats with unread
				// messages have a row, and only those need the flag.
				agentDirect: sql<boolean>`EXISTS (
					SELECT 1 FROM conversations ud
					WHERE ud.id = ${messages.conversationId}
						AND ud.direct_pair_key IS NOT NULL
						AND EXISTS (
							SELECT 1 FROM conversation_participants udp
							INNER JOIN actors uda ON uda.id = udp.actor_id
							WHERE udp.conversation_id = ud.id AND udp.left_at IS NULL AND uda.type = 'agent'
						)
				)`,
			})
			.from(messages)
			.innerJoin(
				conversationParticipants,
				and(
					eq(conversationParticipants.conversationId, messages.conversationId),
					eq(conversationParticipants.actorId, callerId),
				),
			)
			.where(
				and(
					inArray(messages.conversationId, conversationIds),
					ne(messages.actorId, callerId),
					sql`${messages.id} > COALESCE(${conversationParticipants.lastReadMessageId}, 0)`,
				),
			)
			.groupBy(messages.conversationId),
		db
			.select({
				conversationId: sql<string>`${notifications.metadata}->>'conversation_id'`,
				content: notifications.content,
				createdAt: notifications.createdAt,
			})
			.from(notifications)
			.where(
				and(
					eq(notifications.targetActorId, callerId),
					eq(notifications.type, 'needs_input'),
					inArray(notifications.status, ['pending', 'seen']),
					sql`${notifications.metadata}->>'push_category' = 'needs_you'`,
					inArray(sql`${notifications.metadata}->>'conversation_id'`, conversationIds),
					gt(notifications.createdAt, cutoff),
				),
			),
		db
			.select({
				conversationId: messages.conversationId,
				content: messages.content,
				createdAt: messages.createdAt,
			})
			.from(messages)
			.where(
				and(
					inArray(messages.conversationId, conversationIds),
					ne(messages.actorId, callerId),
					gt(messages.createdAt, cutoff),
					notAnswered(),
					isRequestCard(),
				),
			)
			.orderBy(desc(messages.id)),
	])

	const newestCard = new Map<string, number>()
	const addCard = (conversationId: string, text: string | null, at: Date | null) => {
		const entry = result.get(conversationId)
		if (!entry) return
		entry.openCards += 1
		const time = at?.getTime() ?? 0
		if (time >= (newestCard.get(conversationId) ?? -1)) {
			newestCard.set(conversationId, time)
			const line = text ? previewText(text) : ''
			entry.cardText = line.length > 0 ? line : entry.cardText
		}
	}
	for (const row of questionRows) addCard(row.conversationId, row.content, row.createdAt)
	for (const row of requestCardRows) addCard(row.conversationId, row.content, row.createdAt)

	for (const row of unreadRows) {
		const entry = result.get(row.conversationId)
		if (!entry) continue
		entry.mentionsUnread = row.mentions
		if (row.agentDirect) {
			// In a direct chat with an agent every new message counts, so the unread total is the badge.
			entry.unreadCount = row.unread
		}
	}
	// Mentions plus open cards, or the unread total when that is more (a direct chat with an agent).
	for (const entry of result.values()) {
		entry.unreadCount = Math.max(entry.unreadCount, entry.mentionsUnread + entry.openCards)
	}
	return result
}
