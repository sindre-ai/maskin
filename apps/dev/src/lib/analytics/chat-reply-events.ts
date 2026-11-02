import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/**
 * `session`: the session that answered is the one for the thread the message was written in (a
 * thread session for a thread message, the main session for a main-chat message).
 * `fallback`: the single-session path answered a message from another place, for example a thread
 * message that reached the main session because the flag is off, the per-agent cap was reached or
 * the workspace had no chat capacity.
 */
export type ChatReplyPath = 'session' | 'fallback'

export interface ChatReplyPostedProps {
	workspaceId: string
	conversationId: string
	/** The agent that replied; the distinct id. */
	agentId: string
	/** The thread the answering session belongs to; null for the main-chat session. */
	sessionThreadRootId: number | null
	/** The thread the reply was posted in; null for the main chat. */
	replyThreadRootId: number | null
	/** The thread the chat message that started the turn sits in; null for the main chat. */
	originThreadRootId: number | null
	/** The chat message that started the turn; null when it cannot be told (a seeded first turn). */
	originMessageId: number | null
	/** Milliseconds from the origin message to this reply; null without an origin message. */
	latencyMs: number | null
	path: ChatReplyPath
	/** The end-of-turn reply, or a post the agent made mid-turn. */
	source: 'final_output' | 'post'
}

/** The path is `session` when the answering session is the one for the origin message's place. */
export function chatReplyPath(
	sessionThreadRootId: number | null,
	originThreadRootId: number | null,
): ChatReplyPath {
	return sessionThreadRootId === originThreadRootId ? 'session' : 'fallback'
}

/**
 * One event per reply an agent posts into a chat, so the thread-sessions bet can be judged: a
 * reply is in the right place when the session and reply thread ids match on the `session` path.
 * Ids and counts only, never message text. Best-effort: never throws or rejects, so callers fire
 * it without awaiting.
 */
export async function trackChatReplyPosted(p: ChatReplyPostedProps): Promise<void> {
	try {
		await capturePosthogEvent('chat_reply_posted', p.agentId, {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
			agent_id: p.agentId,
			session_thread_root_id: p.sessionThreadRootId,
			reply_thread_root_id: p.replyThreadRootId,
			origin_thread_root_id: p.originThreadRootId,
			origin_message_id: p.originMessageId,
			latency_ms: p.latencyMs,
			path: p.path,
			source: p.source,
		})
	} catch (err) {
		logger.warn('Failed to emit chat_reply_posted', {
			conversationId: p.conversationId,
			error: String(err),
		})
	}
}
