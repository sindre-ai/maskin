import type { ActivityStep } from '@/components/agents/session-log-transcript'
import {
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
} from '@/components/agents/session-log-transcript'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
import { useActiveSessionsForConversation } from './use-sessions'

export interface MessageTurnActivity {
	sessionId: string
	actorId: string
	steps: ActivityStep[]
	/** True for the single most recent turn of a session that hasn't reached a `result` envelope yet. */
	inProgress: boolean
}

export interface ConversationActivity {
	/** Completed/in-progress turns keyed by the `messages.id` that triggered them. */
	byMessageId: Map<number, MessageTurnActivity[]>
	/**
	 * A session's turn shows up here instead of `byMessageId` when it's still
	 * in progress but its `maskin_message_id` tag hasn't been logged yet (the
	 * brief window between a turn starting and its first log row landing) or
	 * it's an older session whose turns predate message-id tagging. The
	 * caller should attach these to the newest message in the thread so
	 * something still shows immediately, matching the old "typing indicator"
	 * behavior for this edge case.
	 */
	fallback: MessageTurnActivity[]
}

/**
 * Segments every active (status=running) session tied to a conversation into
 * per-message activity turns. A single interactive session stays open and
 * accumulates logs for the conversation's whole lifetime, so this is what
 * lets the chat thread show a separate, scoped activity dropdown under each
 * message instead of one dropdown that mixes every turn together.
 */
export function useConversationActivity(
	workspaceId: string,
	conversationId: string | null,
): ConversationActivity {
	const { data: sessions } = useActiveSessionsForConversation(workspaceId, conversationId)
	const activeSessions = sessions ?? []

	const logsQueries = useQueries({
		queries: activeSessions.map((session) => ({
			queryKey: [...queryKeys.sessions.logs(session.id), 'all'],
			queryFn: () => api.sessions.logs(session.id, workspaceId, { limit: '500' }),
			refetchInterval: 3000,
		})),
	})

	const byMessageId = new Map<number, MessageTurnActivity[]>()
	const fallback: MessageTurnActivity[] = []

	activeSessions.forEach((session, i) => {
		const logs = logsQueries[i]?.data ?? []
		const { segments, unassigned } = segmentActivityByMessage(logs)
		const idle = isSessionIdleAwaitingInput(logs)

		segments.forEach((segment, segmentIndex) => {
			const inProgress = !idle && segmentIndex === segments.length - 1
			const list = byMessageId.get(segment.conversationMessageId) ?? []
			list.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: segment.steps,
				inProgress,
			})
			byMessageId.set(segment.conversationMessageId, list)
		})

		// Still working but nothing tagged yet — either a turn that just
		// started (log rows haven't caught up) or unassigned steps left over
		// from a pre-tagging turn.
		if (!idle && (segments.length === 0 || unassigned.length > 0)) {
			fallback.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: unassigned,
				inProgress: true,
			})
		}
	})

	return { byMessageId, fallback }
}
