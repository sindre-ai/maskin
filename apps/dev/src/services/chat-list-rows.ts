import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { and, desc, inArray, sql } from 'drizzle-orm'
import { LIVE_STATUSES, openInteractiveTurnsByLog } from './live-activity-push'

// Per-chat facts the chat list reads, shared by the list route and the list search.

/** The row preview: the words, or the file name(s) when the message is only attachments. */
export function snippetText(content: string, metadata: unknown) {
	if (content.length > 0) return content
	const attachments =
		(metadata as { attachments?: Array<{ name?: string }> } | null)?.attachments ?? []
	if (attachments.length === 0) return content
	const first = attachments[0]?.name?.trim() || 'Attachment'
	return attachments.length === 1 ? first : `${first} and ${attachments.length - 1} more`
}

/**
 * Which agents are answering in each chat right now, and in which session. A chat session stays
 * `running` between turns, so a live status alone would keep the row "working" until the container
 * dies; an interactive session only counts while its turn is open (see `isInteractiveTurnOpenByLog`).
 * Read from the sessions that belong to the chat, so one working agent never lights the other
 * chats it is in. An agent with several live sessions in a chat is listed once, with its newest.
 */
export type WorkingAgent = { agent_id: string; session_id: string }

export async function loadWorkingByConversation(
	db: Database,
	conversationIds: string[],
): Promise<Map<string, WorkingAgent[]>> {
	const byConversation = new Map<string, WorkingAgent[]>()
	if (conversationIds.length === 0) return byConversation
	const live = await db
		.select({
			id: sessions.id,
			actorId: sessions.actorId,
			conversationId: sessions.conversationId,
			interactive: sessions.interactive,
			status: sessions.status,
		})
		.from(sessions)
		.where(
			and(
				inArray(sessions.conversationId, conversationIds),
				inArray(sessions.status, LIVE_STATUSES),
			),
		)
		.orderBy(desc(sessions.createdAt), desc(sessions.id))
	// A session still booting has no logs yet but is on its way to answering; only a running
	// chat session can be sitting idle between turns. One lookup covers all of them.
	const openTurns = await openInteractiveTurnsByLog(
		db,
		live.filter((s) => s.interactive && s.status === 'running').map((s) => s.id),
		Date.now(),
	)
	for (const s of live) {
		if (!s.conversationId) continue
		if (s.interactive && s.status === 'running' && !openTurns.has(s.id)) continue
		const agents = byConversation.get(s.conversationId) ?? []
		if (!agents.some((a) => a.agent_id === s.actorId)) {
			agents.push({ agent_id: s.actorId, session_id: s.id })
		}
		byConversation.set(s.conversationId, agents)
	}
	return byConversation
}

export type SnippetRow = {
	conversationId: string
	snippet: string
	snippetActorId: string
	snippetActorName: string | null
	// The newest visible message as stored, so the list can tell a failed turn from a reply.
	content: string
	metadata: unknown
}

/**
 * The newest message the thread shows in each conversation, with its author, in one statement
 * (a lateral lookup per id, each an index walk down `messages` for that conversation).
 *
 * Only what the thread itself shows: a helper's result handed to the agent that started it, and a
 * card button's nudge (`helper_return`, `hidden_from_chat`), are delivered to the agent but hidden
 * from the chat, so they must not be the row's preview either. Mirrors the filter in apps/web
 * `thread-messages.tsx`. The sender comes back with the preview so the row can say who is talking.
 * Left-joined: a message from an actor that has since been deleted still yields its text rather
 * than dropping the snippet. A conversation with no visible message has no entry.
 */
export async function loadLatestSnippets(
	db: Database,
	conversationIds: string[],
): Promise<Map<string, SnippetRow>> {
	const byConversation = new Map<string, SnippetRow>()
	if (conversationIds.length === 0) return byConversation
	const rows = (await db.execute(sql`
		SELECT ids.conversation_id AS conversation_id,
			latest.content AS content,
			latest.metadata AS metadata,
			latest.actor_id AS actor_id,
			latest.actor_name AS actor_name
		FROM unnest(ARRAY[${sql.join(
			conversationIds.map((id) => sql`${id}::uuid`),
			sql`, `,
		)}]) AS ids(conversation_id)
		CROSS JOIN LATERAL (
			SELECT m.content, m.metadata, m.actor_id, a.name AS actor_name
			FROM messages m
			LEFT JOIN actors a ON a.id = m.actor_id
			WHERE m.conversation_id = ids.conversation_id
				AND (m.metadata->>'helper_return') IS NULL
				AND coalesce(m.metadata->>'hidden_from_chat', 'false') <> 'true'
			ORDER BY m.id DESC
			LIMIT 1
		) latest
	`)) as unknown as Array<{
		conversation_id: string
		content: string
		metadata: unknown
		actor_id: string
		actor_name: string | null
	}>
	for (const row of rows) {
		byConversation.set(row.conversation_id, {
			conversationId: row.conversation_id,
			snippet: snippetText(row.content, row.metadata),
			snippetActorId: row.actor_id,
			snippetActorName: row.actor_name,
			content: row.content,
			metadata: row.metadata,
		})
	}
	return byConversation
}
