import type { Database } from '@maskin/db'
import { messages, sessionLogs, sessions } from '@maskin/db/schema'
import { splitLines } from '@maskin/shared'
import { and, desc, eq, like, lte } from 'drizzle-orm'
import { logger } from '../lib/logger'

/**
 * Where an interactive agent's turn came from: the chat message that started it, and the
 * thread that message sits in. Shared by the end-of-turn reply (interactive-turn-finalizer)
 * and a mid-turn post_conversation_message, so both answer in the same place.
 */

/**
 * Every complete line in one session_logs row.
 *
 * splitLines drops the trailing partial, which for a stored row is the last
 * envelope when the chunk did not end on a newline — so terminate the row
 * first. A row is only ever a whole number of envelopes by the time it is
 * persisted; the cross-chunk partial is reassembled live by onStdout.
 */
export const splitRowLines = (content: string): string[] =>
	splitLines(content.endsWith('\n') ? content : `${content}\n`).lines

/**
 * Which chat message's turn is running, or produced the output at `logId`.
 *
 * writeInput tags each user turn's persisted envelope with `maskin_message_id`; the
 * nearest such envelope (at or before `logId`, or the newest one when it is omitted) is
 * the turn in question. Null is fine — a seeded first turn may carry no message id, and
 * the frontend anchors those by position instead.
 *
 * Split into lines because the tagged envelope can share a Docker chunk with its
 * neighbours, and parsing the whole row would throw and silently yield an unanchored
 * message.
 */
export async function resolveTurnMessageId(
	db: Database,
	sessionId: string,
	logId?: number,
): Promise<number | null> {
	const [row] = await db
		.select({ content: sessionLogs.content })
		.from(sessionLogs)
		.where(
			and(
				eq(sessionLogs.sessionId, sessionId),
				...(logId === undefined ? [] : [lte(sessionLogs.id, logId)]),
				eq(sessionLogs.stream, 'stdout'),
				like(sessionLogs.content, '%maskin_message_id%'),
			),
		)
		.orderBy(desc(sessionLogs.id))
		.limit(1)

	if (!row) return null
	const lines = splitRowLines(row.content)
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse((lines[i] ?? '').trim()) as { maskin_message_id?: unknown }
			if (typeof parsed.maskin_message_id === 'number') return parsed.maskin_message_id
		} catch {
			// Not JSON, or a partial — keep walking the row's other lines.
		}
	}
	return null
}

/**
 * A reply to a message posted inside a thread answers in that thread. The turn's
 * triggering message is either the thread's root (which starts the thread) or one
 * of its replies; only a reply carries a root, so an agent answering a top-level
 * message still posts to the main timeline. Best-effort: a lookup failure posts
 * the reply top-level rather than losing it.
 *
 * With `conversationId`, a message of another conversation counts as top-level, so a
 * root from elsewhere can never be returned for this chat.
 */
export async function resolveThreadRootId(
	db: Database,
	turnMessageId: number | null,
	conversationId?: string,
): Promise<number | null> {
	if (turnMessageId === null) return null
	try {
		const [row] = await db
			.select({ threadRootId: messages.threadRootId, conversationId: messages.conversationId })
			.from(messages)
			.where(eq(messages.id, turnMessageId))
			.limit(1)
		if (conversationId !== undefined && row?.conversationId !== conversationId) return null
		return row?.threadRootId ?? null
	} catch (err) {
		logger.warn(
			`Could not resolve thread for message ${turnMessageId}: ${err instanceof Error ? err.stack || err.message : String(err)}`,
		)
		return null
	}
}

/**
 * Where an agent's reply from this session goes. A thread session answers in its own thread,
 * whatever message started the turn, so the place is fixed by the session. A session with no
 * thread (the main chat, or any session that started before thread sessions existed) keeps
 * the turn-origin guess: a turn started by a thread message answers in that thread.
 *
 * `sessionThreadRootId` is returned too, for reply tracking. A lookup failure answers
 * top-level rather than losing the reply, like resolveThreadRootId.
 */
export async function resolveReplyThreadRootId(
	db: Database,
	params: { sessionId: string; turnMessageId: number | null; conversationId?: string },
): Promise<{ sessionThreadRootId: number | null; threadRootId: number | null }> {
	let sessionThreadRootId: number | null = null
	try {
		const [row] = await db
			.select({ threadRootId: sessions.threadRootId })
			.from(sessions)
			.where(eq(sessions.id, params.sessionId))
			.limit(1)
		sessionThreadRootId = row?.threadRootId ?? null
	} catch (err) {
		logger.warn(
			`Could not read the thread of session ${params.sessionId}: ${err instanceof Error ? err.stack || err.message : String(err)}`,
		)
	}
	if (sessionThreadRootId !== null) {
		return { sessionThreadRootId, threadRootId: sessionThreadRootId }
	}
	return {
		sessionThreadRootId: null,
		threadRootId: await resolveThreadRootId(db, params.turnMessageId, params.conversationId),
	}
}
