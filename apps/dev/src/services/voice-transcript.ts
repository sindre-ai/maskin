import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	voiceSessions,
	workspaces,
} from '@maskin/db/schema'
import { CONVERSATION_TITLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '@maskin/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { recordEvent } from '../lib/events/record-event'
import { insertConversationMessage } from './conversation-messages'

/** Idle window a voice session survives with no transcript activity. Matches the mint route's timeout_at. */
export const VOICE_IDLE_TIMEOUT_MS = 15 * 60 * 1000

export type VoiceSessionRow = typeof voiceSessions.$inferSelect
export type VoiceTranscriptRole = 'user' | 'assistant'

/**
 * Workspace opt-out. Absent means persist; only an explicit
 * settings.voice.persist_transcripts = false turns transcripts off. Read live
 * on every write (not cached at connect) so flipping the setting mid-call
 * stops the next line from landing.
 */
export async function isTranscriptPersistenceEnabled(
	db: Database,
	workspaceId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const voice = (row?.settings as { voice?: { persist_transcripts?: unknown } } | null)?.voice
	return voice?.persist_transcripts !== false
}

/**
 * Returns the conversation this call writes into, creating it on first use.
 * A call launched against an existing chat already has voice_sessions.conversation_id
 * and reuses it. The voice_sessions row is locked for the check-and-create so
 * two sockets for the same session cannot each create a conversation.
 */
export async function ensureVoiceConversation(
	db: Database,
	session: Pick<VoiceSessionRow, 'id' | 'workspaceId' | 'humanActorId' | 'agentActorId'>,
	agentName: string,
): Promise<string> {
	return db.transaction(async (tx) => {
		const [locked] = await tx
			.select({ conversationId: voiceSessions.conversationId })
			.from(voiceSessions)
			.where(eq(voiceSessions.id, session.id))
			.for('update')
		if (locked?.conversationId) return locked.conversationId

		const title = `Voice call with ${agentName}`.slice(0, CONVERSATION_TITLE_MAX_LENGTH)
		const [created] = await tx
			.insert(conversations)
			.values({ workspaceId: session.workspaceId, title, createdBy: session.humanActorId })
			.returning({ id: conversations.id })
		if (!created) throw new Error('Failed to create voice conversation')

		const participantIds = [session.humanActorId, session.agentActorId]
		await tx.insert(conversationParticipants).values(
			participantIds.map((actorId) => ({
				conversationId: created.id,
				actorId,
				addedBy: session.humanActorId,
			})),
		)
		await tx
			.update(voiceSessions)
			.set({ conversationId: created.id })
			.where(eq(voiceSessions.id, session.id))
		await recordEvent(tx, {
			workspaceId: session.workspaceId,
			actorId: session.humanActorId,
			action: 'conversation_created',
			entityType: 'conversation',
			entityId: created.id,
			data: { participant_actor_ids: participantIds, source: 'voice' },
		})
		return created.id
	})
}

export interface WriteVoiceTranscriptLineArgs {
	session: Pick<VoiceSessionRow, 'id' | 'workspaceId' | 'humanActorId' | 'agentActorId'>
	agentName: string
	role: VoiceTranscriptRole
	text: string
}

/**
 * Persist one transcript line as a chat message: the human's words under the
 * human's actor, the agent's under the agent's, each tagged
 * metadata = { source: 'voice', voice_session_id }.
 *
 * Returns null and writes nothing when the workspace has opted out or the line
 * is blank. Goes through insertConversationMessage, not the POST /messages
 * route, so a spoken line cannot wake an agent through @mention auto-join or
 * the conversation responder — the call itself is the live exchange.
 */
export async function writeVoiceTranscriptLine(
	db: Database,
	args: WriteVoiceTranscriptLineArgs,
): Promise<{ conversationId: string; messageId: number } | null> {
	const text = args.text.trim().slice(0, MESSAGE_MAX_LENGTH)
	if (!text) return null
	if (!(await isTranscriptPersistenceEnabled(db, args.session.workspaceId))) return null

	const conversationId = await ensureVoiceConversation(db, args.session, args.agentName)
	const message = await insertConversationMessage(db, {
		conversationId,
		workspaceId: args.session.workspaceId,
		actorId: args.role === 'user' ? args.session.humanActorId : args.session.agentActorId,
		content: text,
		metadata: { source: 'voice', voice_session_id: args.session.id },
		sessionId: null,
	})
	if (!message) throw new Error('Voice transcript message insert was suppressed')

	// Activity keeps the call alive: push the idle deadline out from now.
	await db
		.update(voiceSessions)
		.set({ timeoutAt: new Date(Date.now() + VOICE_IDLE_TIMEOUT_MS) })
		.where(
			and(
				eq(voiceSessions.id, args.session.id),
				inArray(voiceSessions.status, ['pending', 'active']),
			),
		)

	return { conversationId, messageId: message.id }
}
