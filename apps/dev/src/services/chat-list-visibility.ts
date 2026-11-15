import { type SQL, sql } from 'drizzle-orm'

/**
 * A topic chat with nobody writing for this many days is quiet. One value for everything that
 * decides it: the default list leaves quiet chats out and the Quiet view lists them.
 */
export const QUIET_CHAT_DAYS = 7

type QuietArgs = {
	/** The person the list is for: their sections keep a chat out of Quiet. */
	callerId: string
	/** The unread rule for one chat (unreadChatCondition), so a chat waiting on the person never goes Quiet. */
	unread: SQL
	/** Chats where an agent has an open turn right now. They never go Quiet. */
	runningIds: string[]
}

/**
 * The listing rules behind the chat list's `hide_quiet` filter and its Quiet view. Nothing is
 * stored or archived: a chat that matches is only left out of the default list, stays in the Quiet
 * view and in search, and comes back by itself when a new message moves its last_message_at.
 *
 * Chat kind is worked out from who is in it, never stored: the direct message (DM) is the
 * chat with a direct_pair_key; more than two people is a group; any other chat is a topic
 * chat. A chat about an object or a flow (subject_id set) counts as a group chat, which
 * these rules never touch. Neither do people-only chats.
 *
 * Quiet (left out of the default list, listed in the Quiet view):
 * - a DM or topic chat with a retired agent (description starts with RETIRED, the same
 *   marker as isRetiredAgent in default-heartbeat.ts);
 * - a topic chat with an agent whose last message is older than QUIET_CHAT_DAYS.
 *
 * Never quiet, whatever the rules above say: pinned chats, rooms (is_room), chats the person put
 * in one of their sections, chats with an agent running, and unread chats (see chat-unread.ts).
 *
 * Also left out of the default list, and in no view: a DM with an agent that has no message yet.
 * It has nothing to show, and every agent keeps its own row in the list.
 *
 * Table names (not Drizzle column refs) inside the subqueries, for the same reason as the
 * unread subquery in the list route: a column object renders unqualified and can bind to
 * the inner alias.
 */
function quietRules({ callerId, unread, runningIds }: QuietArgs) {
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

	const inSection = sql`EXISTS (
		SELECT 1 FROM chat_section_items csi
		WHERE csi.conversation_id = conversations.id AND csi.actor_id = ${callerId}
	)`
	const running =
		runningIds.length === 0
			? sql`false`
			: sql`conversations.id IN (${sql.join(
					runningIds.map((id) => sql`${id}::uuid`),
					sql`, `,
				)})`

	const exempt = sql`(
		conversation_participants.pinned
		OR conversations.is_room
		OR ${unread}
		OR ${inSection}
		OR ${running}
	)`
	const quiet = sql`(
		(${isDirect} AND ${hasAgent} AND ${hasRetiredAgent})
		OR (${isTopic} AND ${hasRetiredAgent})
		OR (${isTopic} AND ${hasAgent} AND conversations.last_message_at < ${quietCutoff})
	)`
	const emptyAgentDirect = sql`(${isDirect} AND ${hasAgent} AND NOT ${hasMessage})`
	return { exempt, quiet, emptyAgentDirect }
}

/** The default list (hide_quiet): everything except quiet chats and empty DMs with agents. */
export function visibleInDefaultListCondition(args: QuietArgs): SQL {
	const { exempt, quiet, emptyAgentDirect } = quietRules(args)
	return sql`(${exempt} OR NOT (${quiet} OR ${emptyAgentDirect}))`
}

/** The Quiet view: the chats the default list leaves out for being quiet, not the empty DMs. */
export function quietViewCondition(args: QuietArgs): SQL {
	const { exempt, quiet } = quietRules(args)
	return sql`(NOT ${exempt} AND ${quiet})`
}
