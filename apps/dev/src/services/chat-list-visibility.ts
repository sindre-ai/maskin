import { type SQL, sql } from 'drizzle-orm'

/** A topic chat with nobody writing for this many days leaves the default chat list. */
export const QUIET_CHAT_DAYS = 14

/**
 * The listing rules behind the chat list's `hide_quiet` filter. Nothing is stored or
 * archived: a chat that matches is only left out of that list, stays in search, and
 * comes back by itself when a new message moves its last_message_at.
 *
 * Chat kind is worked out from who is in it, never stored: the direct message (DM) is the
 * chat with a direct_pair_key; more than two people is a group; any other chat is a topic
 * chat. A chat about an object or a flow (subject_id set) counts as a group chat, which
 * these rules never touch. Neither do people-only chats, pinned chats or unread chats.
 *
 * Hidden:
 * - a DM with an agent that has no message yet;
 * - a DM or topic chat with a retired agent (description starts with RETIRED, the same
 *   marker as isRetiredAgent in default-heartbeat.ts);
 * - a topic chat with an agent whose last message is older than QUIET_CHAT_DAYS.
 *
 * Table names (not Drizzle column refs) inside the subqueries, for the same reason as the
 * unread subquery in the list route: a column object renders unqualified and can bind to
 * the inner alias.
 */
export function visibleInDefaultListCondition(hasUnread: SQL): SQL {
	const activeParticipants = sql`(
		SELECT count(*) FROM conversation_participants p
		WHERE p.conversation_id = conversations.id AND p.left_at IS NULL
	)`
	const hasAgent = sql`EXISTS (
		SELECT 1 FROM conversation_participants p
		INNER JOIN actors a ON a.id = p.actor_id
		WHERE p.conversation_id = conversations.id AND p.left_at IS NULL AND a.type = 'agent'
	)`
	const hasRetiredAgent = sql`EXISTS (
		SELECT 1 FROM conversation_participants p
		INNER JOIN actors a ON a.id = p.actor_id
		WHERE p.conversation_id = conversations.id AND p.left_at IS NULL
			AND a.type = 'agent' AND a.description LIKE 'RETIRED%'
	)`
	const hasMessage = sql`EXISTS (
		SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id
	)`
	const isDirect = sql`conversations.direct_pair_key IS NOT NULL`
	const isTopic = sql`(
		conversations.direct_pair_key IS NULL
		AND conversations.subject_id IS NULL
		AND ${activeParticipants} <= 2
	)`
	const quietCutoff = sql`now() - interval '${sql.raw(String(QUIET_CHAT_DAYS))} days'`

	const hidden = sql`(
		(${isDirect} AND ${hasAgent} AND (NOT ${hasMessage} OR ${hasRetiredAgent}))
		OR (${isTopic} AND ${hasRetiredAgent})
		OR (${isTopic} AND ${hasAgent} AND conversations.last_message_at < ${quietCutoff})
	)`
	return sql`(
		conversation_participants.pinned
		OR ${hasUnread}
		OR NOT ${hidden}
	)`
}
