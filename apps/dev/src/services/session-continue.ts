import type { sessions } from '@maskin/db/schema'
import { helperAskConversationId } from '../lib/session-access'
import { isNotifyOnComplete } from './mention-guards'
import { startSession } from './session-lifecycle'

type SessionRow = typeof sessions.$inferSelect

/**
 * Carries on with a sub-chat that has already ended: starts a new interactive session
 * for the same agent that stays open, hangs it from the same message so it is another
 * thread of the same chat, and makes the person's follow-up its first turn.
 *
 * Shared by `POST /sessions/:id/continue` (the thread composer) and the thread-reply
 * routing, so a reply typed in the web app and one posted through the API start the
 * same kind of follow-up. The caller has already checked that the session has ended
 * and that `actorId` may write to it.
 */
export async function continueEndedSession(
	session: SessionRow,
	input: { workspaceId: string; actorId: string; content: string },
): Promise<{ sessionId: string }> {
	const { workspaceId, actorId } = input
	const id = session.id

	// The person's words are the session's prompt, as in any chat: that is what its first
	// message and its title show. What the agent did before reaches it through the system
	// prompt at launch (config.continues_*), not through this text.
	const earlier = (session.actionPrompt ?? '').trim().slice(0, 600)
	const actionPrompt = input.content.trim()

	const origin = (session.config ?? {}) as { origin_conversation_id?: unknown; hop_depth?: unknown }
	const relaunched = (session.config as { relaunching?: unknown } | null)?.relaunching === true
	const config = {
		interactive: true,
		// Ends after its reply, like the helper it continues, so the thread reads Done between
		// messages; the next message starts the next follow-up.
		stop_on_result: true,
		sent_by_actor_id: actorId,
		continues_session_id: id,
		continues_chain: [
			...(Array.isArray((session.config as { continues_chain?: unknown } | null)?.continues_chain)
				? ((session.config as { continues_chain: unknown[] }).continues_chain.filter(
						(x) => typeof x === 'string',
					) as string[])
				: []),
			id,
		],
		continues_prompt: earlier,
		...(helperAskConversationId(session)
			? { ask_conversation_id: helperAskConversationId(session) }
			: {}),
		...(typeof origin.origin_conversation_id === 'string'
			? { origin_conversation_id: origin.origin_conversation_id }
			: {}),
		...(typeof origin.hop_depth === 'number' ? { hop_depth: origin.hop_depth } : {}),
		// Stopped to carry on with a credential or access a person just gave it: the follow-up
		// reports to the sender in its place, so the sender hears one ending, not two.
		...(relaunched && isNotifyOnComplete(session.config) ? { notify_on_complete: true } : {}),
	}
	const handle = await startSession({
		workspaceId,
		actorId: session.actorId,
		callerKind: 'rest',
		actionPrompt,
		config,
		createdBy: actorId,
		initiatedFromObjectId: session.initiatedFromObjectId,
		await: 'none',
		// Another thread of the same chat: the anchor message when there is one, else the
		// chat session that started the original.
		spawnedByMessageId: session.spawnedByMessageId ?? undefined,
		spawnedBySessionId:
			session.spawnedByMessageId && !relaunched
				? undefined
				: (session.spawnedBySessionId ?? undefined),
	})
	return { sessionId: handle.sessionId }
}
