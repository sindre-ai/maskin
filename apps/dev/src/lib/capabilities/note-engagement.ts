import type { Database } from '@maskin/db'
import { sql } from 'drizzle-orm'

export interface NoteEngagement {
	/** The person's message_posted rows in the conversation after the note. */
	replies: Array<{ eventId: number; messageId: number; at: Date }>
	/** The person's read-state updates at or past the note's message. */
	opens: Array<{ eventId: number; lastReadMessageId: number; at: Date }>
}

/**
 * Replies and opens for one proactive note, read from the events table only
 * (the Product Validator reads these from the database, not PostHog):
 * - a reply is a message_posted event by the person after the note's message id
 * - an open is a conversation_participant_state_updated event by the person
 *   whose last_read_message_id is at or past the note's message id
 */
export async function readNoteEngagement(
	db: Database,
	params: {
		workspaceId: string
		conversationId: string
		noteMessageId: number
		personId: string
	},
): Promise<NoteEngagement> {
	const { workspaceId, conversationId, noteMessageId, personId } = params
	const rows = (await db.execute(sql`
		SELECT 'reply' AS kind, id AS event_id, (data->>'message_id')::bigint AS message_id, created_at
		FROM events
		WHERE workspace_id = ${workspaceId}
			AND entity_id = ${conversationId}
			AND action = 'message_posted'
			AND actor_id = ${personId}
			AND (data->>'message_id')::bigint > ${noteMessageId}
		UNION ALL
		SELECT 'open' AS kind, id AS event_id, (data->>'last_read_message_id')::bigint AS message_id, created_at
		FROM events
		WHERE workspace_id = ${workspaceId}
			AND entity_id = ${conversationId}
			AND action = 'conversation_participant_state_updated'
			AND actor_id = ${personId}
			AND (data->>'last_read_message_id')::bigint >= ${noteMessageId}
		ORDER BY event_id
	`)) as unknown as Array<{
		kind: 'reply' | 'open'
		event_id: string | number
		message_id: string | number
		created_at: Date
	}>

	const out: NoteEngagement = { replies: [], opens: [] }
	for (const row of rows) {
		const eventId = Number(row.event_id)
		const messageId = Number(row.message_id)
		const at = new Date(row.created_at)
		if (row.kind === 'reply') out.replies.push({ eventId, messageId, at })
		else out.opens.push({ eventId, lastReadMessageId: messageId, at })
	}
	return out
}
