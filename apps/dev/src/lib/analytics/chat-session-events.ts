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
		logger.info('GATE_TEST event chat_session_seeded', {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
			agent_id: p.agentId,
			thread_root_id: p.threadRootId,
			files_listed_count: p.filesListedCount,
		})
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

/** Server event for a chat session closed on purpose so the next message starts a fresh one. */
export const CHAT_SESSION_ROTATED_EVENT = 'chat_session_rotated'

export interface ChatSessionRotatedProps {
	workspaceId: string
	agentId: string
	/** size: the window passed the rotation line. compaction_failed: the CLI's compaction failed or looped. */
	reason: 'size' | 'compaction_failed'
	/** The LLM route the session ran on (sessions.config.llm_route); null when not recorded. */
	route: string | null
	/** A coarse bucket for the window size at the last turn, never the raw number. */
	sizeBucket: string
	/** ok: the handoff note was written and stored. fallback: it failed, the fresh session is seeded as before. */
	handoff: 'ok' | 'fallback'
}

/**
 * One event per rotation, the success event of the "keep long sessions from filling up" bet. Read
 * with chat_session_seeded: a rotated event, then a seeded event in the same chat, is a clean
 * restart. Names, ids, buckets only, never message or note text. Best-effort: never throws, so
 * callers fire it without awaiting.
 */
export async function trackChatSessionRotated(p: ChatSessionRotatedProps): Promise<void> {
	try {
		logger.info('GATE_TEST event chat_session_rotated', {
			reason: p.reason,
			route: p.route,
			agent_id: p.agentId,
			workspace_id: p.workspaceId,
			size_bucket: p.sizeBucket,
			handoff: p.handoff,
		})
		await capturePosthogEvent(CHAT_SESSION_ROTATED_EVENT, p.agentId, {
			reason: p.reason,
			route: p.route,
			agent_id: p.agentId,
			workspace_id: p.workspaceId,
			size_bucket: p.sizeBucket,
			handoff: p.handoff,
		})
	} catch (err) {
		logger.warn('Failed to emit chat_session_rotated', {
			agentId: p.agentId,
			error: String(err),
		})
	}
}
