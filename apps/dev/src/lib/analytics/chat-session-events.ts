import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/**
 * Server event for a fresh chat session. Its own name, not chat_session_started: that one is sent by
 * the browser when a chat is created, and a second sender under the same name would double every
 * count of it.
 */
export const CHAT_SESSION_SEEDED_EVENT = 'chat_session_seeded'

export interface ChatSessionSeededProps {
	workspaceId: string
	conversationId: string
	agentId: string
	/** The thread the session is for; null for the agent's main-chat session. */
	threadRootId: number | null
	/** How many files the session's "Files in this chat" list holds. A number, never names. */
	filesListedCount: number
}

/**
 * One event per chat session the platform starts, with the size of the file list it was seeded
 * with. Tells after a deploy whether the list is being filled. Ids and a count only. Distinct id is
 * the agent. Best-effort: never throws, so callers fire it without awaiting.
 */
export async function trackChatSessionSeeded(p: ChatSessionSeededProps): Promise<void> {
	try {
		await capturePosthogEvent(CHAT_SESSION_SEEDED_EVENT, p.agentId, {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
			agent_id: p.agentId,
			thread_root_id: p.threadRootId,
			files_listed_count: p.filesListedCount,
		})
	} catch (err) {
		logger.warn('Failed to emit chat_session_seeded', {
			conversationId: p.conversationId,
			error: String(err),
		})
	}
}
