import type { Database } from '@maskin/db'
import { REQUEST_CARD_METADATA_KEYS } from '@maskin/shared'
import { sql } from 'drizzle-orm'
import { loadLatestSnippets, loadWorkingByConversation } from './chat-list-rows'
import { type TurnMetadata, USAGE_LIMIT_TEXT, failureOf } from './chat-needs-person'

/**
 * What a chat is waiting on from the person, read from the chat's own messages. Nothing is
 * stored and no session status is read: the question and card stamps on the messages are the
 * source, so one agent waiting in one chat never lights the other chats it is in.
 *
 * A chat needs the person (see the chat list, "Needs you") when it holds
 * - an agent question nobody answered,
 * - a request card (keychain, access, tool server, computer) nobody answered, or
 * - a last turn that failed.
 * The route also leaves it out when the person marked the chat Done (archived) or Later.
 */

export type ChatErrorReason = 'usage_limit' | 'connection' | 'other'

/**
 * Request cards only carry the answered stamp (metadata.card_resolved) from 8 Nov 2026
 * (card-resolution.ts). An older card has no stamp and nothing else says whether it was answered,
 * so it would read as open for ever. Cards posted before this day are not counted.
 */
export const CARD_STAMPS_FROM = new Date('2026-11-09T00:00:00Z')

type AskRow = {
	id: number
	conversation_id: string
	thread_root_id: number | null
	session_id: string | null
	is_question: boolean
	from_helper: boolean
	/** Set for a request card only: its metadata, to read the kind and what it is about. */
	card_metadata: Record<string, unknown> | null
	resolved: boolean
}

type ReplyRow = { id: number; conversation_id: string; thread_root_id: number | null }

function conversationList(ids: string[]) {
	return sql.join(
		ids.map((id) => sql`${id}::uuid`),
		sql`, `,
	)
}

/**
 * The chats among `conversationIds` where the caller has an unanswered agent question or request
 * card. Literal, table-qualified SQL throughout (known-pitfalls: correlated subqueries).
 *
 * A question is answered when a message carries a pick for it (metadata.question_answer), or when
 * the caller typed a normal message after it in the same place (the main chat, or the same
 * thread): one reply closes the newest question still open there, the same rule the chat's own
 * cards follow (apps/web/src/lib/question-answers.ts). A question a helper asked is only answered
 * by a pick. A card is answered when it carries the resolved stamp.
 */
export async function loadChatsWithOpenAsk(
	db: Database,
	callerId: string,
	conversationIds: string[],
): Promise<Set<string>> {
	const open = new Set<string>()
	if (conversationIds.length === 0) return open

	const cardKeys = REQUEST_CARD_METADATA_KEYS.map(
		(key) => sql`(m.metadata -> ${key}::text) IS NOT NULL`,
	)
	// Every card since stamps began is read, answered or not: a card only counts while it is the
	// latest of its kind (see below), and that needs the answered ones too.
	const askRows = (await db.execute(sql`
		SELECT m.id AS id,
			m.conversation_id AS conversation_id,
			m.thread_root_id AS thread_root_id,
			m.session_id AS session_id,
			(m.metadata -> 'question') IS NOT NULL AS is_question,
			coalesce(m.metadata -> 'question' ->> 'reply_to_session', 'false') = 'true' AS from_helper,
			CASE WHEN (m.metadata -> 'question') IS NULL THEN m.metadata END AS card_metadata,
			(m.metadata -> 'card_resolved') IS NOT NULL AS resolved
		FROM messages m
		WHERE m.conversation_id IN (${conversationList(conversationIds)})
			AND m.deleted_at IS NULL
			AND (
				(m.metadata -> 'question') IS NOT NULL
				OR (
					(${sql.join(cardKeys, sql` OR `)})
					AND m.created_at >= ${CARD_STAMPS_FROM.toISOString()}::timestamptz
				)
			)
		ORDER BY m.id
	`)) as unknown as AskRow[]
	// bigint columns can come back from raw SQL as strings, and ids are compared as numbers below.
	const asks = askRows.map((a) => ({
		...a,
		id: Number(a.id),
		thread_root_id: a.thread_root_id === null ? null : Number(a.thread_root_id),
	}))

	// A card is open when it is the latest of its kind that its session asked (for a card about an
	// integration, the latest for that integration) and nobody answered it. An older card of the
	// same kind was replaced by the newer one, which is the one an answer lands on
	// (card-resolution.ts), so it never reads as waiting.
	const latestCard = new Map<string, (typeof asks)[number]>()
	for (const ask of asks) {
		if (ask.is_question) continue
		const key = REQUEST_CARD_METADATA_KEYS.find((k) => ask.card_metadata?.[k] != null)
		if (!key) continue
		const about = (ask.card_metadata?.[key] as { integration_id?: unknown } | undefined)
			?.integration_id
		latestCard.set(
			`${ask.conversation_id}|${ask.session_id ?? ''}|${key}|${typeof about === 'string' ? about : ''}`,
			ask,
		)
	}
	for (const card of latestCard.values()) {
		if (!card.resolved) open.add(card.conversation_id)
	}

	const questions = asks.filter((a) => a.is_question)
	if (questions.length === 0) return open

	// Picks: any message that names the question it answers.
	const picked = (await db.execute(sql`
		SELECT m.metadata -> 'question_answer' ->> 'question_message_id' AS question_id
		FROM messages m
		WHERE m.conversation_id IN (${conversationList([...new Set(questions.map((q) => q.conversation_id))])})
			AND (m.metadata -> 'question_answer') IS NOT NULL
	`)) as unknown as Array<{ question_id: string | null }>
	const answered = new Set<number>()
	for (const row of picked) {
		const id = Number(row.question_id)
		if (Number.isInteger(id)) answered.add(id)
	}

	// Typed replies close the newest open question of their place, so only a chat with a question
	// left after the picks needs them. Only replies after the oldest such question are read.
	const stillOpen = questions.filter((q) => !answered.has(q.id))
	const repliable = stillOpen.filter((q) => !q.from_helper)
	if (repliable.length > 0) {
		const oldest = Math.min(...repliable.map((q) => q.id))
		const replies = (await db.execute(sql`
			SELECT m.id AS id, m.conversation_id AS conversation_id, m.thread_root_id AS thread_root_id
			FROM messages m
			WHERE m.conversation_id IN (${conversationList([...new Set(repliable.map((q) => q.conversation_id))])})
				AND m.actor_id = ${callerId}
				AND m.kind = 'message'
				AND m.deleted_at IS NULL
				AND m.id > ${oldest}
				AND (m.metadata -> 'question_answer') IS NULL
				AND coalesce(m.metadata ->> 'hidden_from_chat', 'false') <> 'true'
				AND (m.metadata ->> 'helper_return') IS NULL
			ORDER BY m.id
		`)) as unknown as ReplyRow[]
		for (const raw of replies) {
			const reply = {
				...raw,
				id: Number(raw.id),
				thread_root_id: raw.thread_root_id === null ? null : Number(raw.thread_root_id),
			}
			let target: AskRow | null = null
			for (const q of repliable) {
				if (q.conversation_id !== reply.conversation_id) continue
				if ((q.thread_root_id ?? null) !== (reply.thread_root_id ?? null)) continue
				if (q.id >= reply.id || answered.has(q.id)) continue
				if (!target || q.id > target.id) target = q
			}
			if (target) answered.add(target.id)
		}
	}

	for (const q of stillOpen) {
		if (!answered.has(q.id)) open.add(q.conversation_id)
	}
	return open
}

type LastMessage = { content: string; metadata: unknown }

/**
 * Whether the newest message the thread shows is the notice of a failed turn, and why it failed.
 * Null for anything else, so a person's new message clears it.
 *
 * Reason: a spent plan or credit is usage_limit, a model-API blip or a replay that could not reach
 * the agent is connection, anything else is other.
 */
export function readFailedTurn(last: LastMessage | undefined): { reason: ChatErrorReason } | null {
	if (!last) return null
	const f = failureOf(last.metadata)
	if (!f) return null
	const meta = last.metadata as TurnMetadata
	// A permanent failure keeps the provider's text in error_detail; the body is a plain line.
	if (
		meta.credit_balance_low ||
		USAGE_LIMIT_TEXT.test(last.content) ||
		USAGE_LIMIT_TEXT.test(f.error_detail ?? '')
	) {
		return { reason: 'usage_limit' }
	}
	if (f.error_kind === 'transient' || f.retry) return { reason: 'connection' }
	return { reason: 'other' }
}

/**
 * The newest message a person wrote in each chat (a normal message, not a hidden nudge or a
 * helper's result), so Retry can run the retry route on it. A chat with none has no entry.
 */
export async function loadLastPersonMessageIds(
	db: Database,
	conversationIds: string[],
): Promise<Map<string, number>> {
	const byConversation = new Map<string, number>()
	if (conversationIds.length === 0) return byConversation
	const rows = (await db.execute(sql`
		SELECT DISTINCT ON (m.conversation_id) m.conversation_id AS conversation_id, m.id AS id
		FROM messages m
		INNER JOIN actors a ON a.id = m.actor_id
		WHERE m.conversation_id IN (${conversationList(conversationIds)})
			AND a.type = 'human'
			AND m.kind = 'message'
			AND m.deleted_at IS NULL
			AND coalesce(m.metadata ->> 'hidden_from_chat', 'false') <> 'true'
			AND (m.metadata ->> 'helper_return') IS NULL
		ORDER BY m.conversation_id, m.id DESC
	`)) as unknown as Array<{ conversation_id: string; id: number }>
	for (const row of rows) byConversation.set(row.conversation_id, Number(row.id))
	return byConversation
}

/** How many of the caller's newest chats the search filters is:needs and is:working look at. */
export const ATTENTION_SEARCH_CHAT_CAP = 500

/**
 * The caller's chats that need them, and the chats where an agent is working, for the search
 * filters is:needs and is:working. Reads the same facts as the list rows, over the caller's
 * newest chats (a chat that waits on someone is almost always a recent one). Only what is asked
 * for is read. A chat the caller marked Done or Later never needs them.
 */
export async function loadAttentionChatIds(
	db: Database,
	args: { workspaceId: string; callerId: string; needs: boolean; working: boolean },
): Promise<{ needs: string[]; working: string[] }> {
	const result = { needs: [] as string[], working: [] as string[] }
	if (!args.needs && !args.working) return result

	const chats = (await db.execute(sql`
		SELECT c.id AS id,
			(cp.archived OR (cp.later_at IS NOT NULL AND cp.later_at >= c.last_message_at)) AS parked
		FROM conversations c
		INNER JOIN conversation_participants cp
			ON cp.conversation_id = c.id AND cp.actor_id = ${args.callerId} AND cp.left_at IS NULL
		WHERE c.workspace_id = ${args.workspaceId}
		ORDER BY c.last_message_at DESC, c.id
		LIMIT ${ATTENTION_SEARCH_CHAT_CAP}
	`)) as unknown as Array<{ id: string; parked: boolean }>

	if (args.working) {
		const working = await loadWorkingByConversation(
			db,
			chats.map((c) => c.id),
		)
		result.working = [...working.keys()]
	}
	if (args.needs) {
		const active = chats.filter((c) => !c.parked).map((c) => c.id)
		const [asks, latest] = await Promise.all([
			loadChatsWithOpenAsk(db, args.callerId, active),
			loadLatestSnippets(db, active),
		])
		result.needs = active.filter((id) => asks.has(id) || readFailedTurn(latest.get(id)) !== null)
	}
	return result
}
