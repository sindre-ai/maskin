import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	liveSessions,
	workspaces,
} from '@maskin/db/schema'
import {
	CONVERSATION_TITLE_MAX_LENGTH,
	MESSAGE_MAX_LENGTH,
	type MessageMetadata,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { insertConversationMessage } from './conversation-messages'

type SessionIds = Pick<
	typeof liveSessions.$inferSelect,
	'id' | 'workspaceId' | 'humanActorId' | 'agentActorId'
>

/**
 * Workspace opt-out. Absent means persist; only an explicit
 * settings.live.persist_transcripts = false turns transcripts off. Read on
 * every write so flipping the setting mid-call stops the next line landing.
 */
export async function isLiveTranscriptEnabled(db: Database, workspaceId: string): Promise<boolean> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const live = (row?.settings as { live?: { persist_transcripts?: unknown } } | null)?.live
	return live?.persist_transcripts !== false
}

/**
 * Returns the conversation a call writes into, creating it on first use. A call
 * launched from an existing chat already has conversation_id and reuses it. The
 * live_sessions row is locked for the check-and-create so two sockets for the
 * same call cannot each create one.
 */
export async function ensureLiveConversation(
	db: Database,
	session: SessionIds,
	agentName: string,
): Promise<string> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ conversationId: liveSessions.conversationId })
			.from(liveSessions)
			.where(eq(liveSessions.id, session.id))
			.for('update')
		if (locked?.conversationId) return locked.conversationId

		const title = `Live with ${agentName}`.slice(0, CONVERSATION_TITLE_MAX_LENGTH)
		const [created] = await tx
			.insert(conversations)
			.values({ workspaceId: session.workspaceId, title, createdBy: session.humanActorId })
			.returning({ id: conversations.id })
		if (!created) throw new Error('Failed to create live conversation')

		const participantIds = [session.humanActorId, session.agentActorId]
		await tx.insert(conversationParticipants).values(
			participantIds.map((actorId) => ({
				conversationId: created.id,
				actorId,
				addedBy: session.humanActorId,
			})),
		)
		await tx
			.update(liveSessions)
			.set({ conversationId: created.id })
			.where(eq(liveSessions.id, session.id))
		await recordEvent(tx, {
			workspaceId: session.workspaceId,
			actorId: session.humanActorId,
			action: 'conversation_created',
			entityType: 'conversation',
			entityId: created.id,
			data: { participant_actor_ids: participantIds, source: 'live' },
		})
		return created.id
	})
}

export interface WriteLiveLineArgs {
	session: SessionIds
	agentName: string
	role: 'user' | 'assistant'
	text: string
	turnIndex: number
	inputMode: 'text' | 'audio'
	/** What the model produced when `text` is only the part that was spoken before an interrupt. */
	fullText?: string
	interrupted?: boolean
	toolCalls?: Array<{ name: string; label: string; ok: boolean }>
}

/**
 * Persists one line of a call as a chat message: the human's words under the
 * human's actor, the agent's under the agent's, tagged source 'live'. Returns
 * null and writes nothing when the workspace opted out or the line is blank.
 *
 * Goes through insertConversationMessage, not POST /messages, so a spoken line
 * can never wake a container session through @mention auto-join or the
 * conversation responder: the call itself is the live exchange.
 */
export async function writeLiveLine(
	db: Database,
	a: WriteLiveLineArgs,
): Promise<{ conversationId: string; messageId: number } | null> {
	const text = a.text.trim().slice(0, MESSAGE_MAX_LENGTH)
	if (!text) return null
	if (!(await isLiveTranscriptEnabled(db, a.session.workspaceId))) return null

	const conversationId = await ensureLiveConversation(db, a.session, a.agentName)
	const metadata: MessageMetadata = {
		source: 'live',
		live_session_id: a.session.id,
		live: {
			turn_index: a.turnIndex,
			input_mode: a.inputMode,
			interrupted: a.interrupted ?? false,
			...(a.fullText !== undefined &&
				a.fullText !== text && { full_text: a.fullText.slice(0, MESSAGE_MAX_LENGTH) }),
			...(a.toolCalls?.length && { tool_calls: a.toolCalls }),
		},
	}
	const message = await insertConversationMessage(db, {
		conversationId,
		workspaceId: a.session.workspaceId,
		actorId: a.role === 'user' ? a.session.humanActorId : a.session.agentActorId,
		content: text,
		metadata,
		sessionId: null,
	})
	if (!message) throw new Error('Live transcript message insert was suppressed')
	return { conversationId, messageId: message.id }
}
