import type { ActivityStep } from '@/components/agents/session-log-transcript'
import {
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
} from '@/components/agents/session-log-transcript'
import { api } from '@/lib/api'
import type { MessageResponse } from '@/lib/api'
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
	/**
	 * A finished turn's dropdown, keyed by the id of the reply message it
	 * actually produced — not the message that triggered it. In a group
	 * conversation several agents (or several turns of the same agent) can
	 * all be triggered by the same message, so anchoring by trigger would
	 * pile every one of those dropdowns under that one message, forever,
	 * regardless of which agent's reply they belong to. Anchoring by the
	 * reply instead means each dropdown ends up sitting with its own message.
	 */
	byReplyMessageId: Map<number, MessageTurnActivity[]>
	/**
	 * A still-in-progress turn's live dropdown, keyed by the message that
	 * triggered it — there's no reply yet to anchor it to. Once the turn
	 * posts a reply it moves to `byReplyMessageId` on the next render; if it
	 * resolves without posting one ("no action needed"), it just disappears.
	 */
	byTriggerMessageId: Map<number, MessageTurnActivity[]>
	/**
	 * A still-in-progress turn whose `maskin_message_id` tag hasn't been
	 * logged yet (the brief window right after a turn starts) or an older
	 * session whose turns predate message-id tagging. The caller should
	 * attach these to the newest message in the thread so something still
	 * shows immediately, matching the old "typing indicator" behavior for
	 * this edge case.
	 */
	fallback: MessageTurnActivity[]
}

/**
 * Segments every active (status=running) session tied to a conversation into
 * per-message activity turns, then re-anchors each finished turn to the
 * reply message it produced (see `byReplyMessageId`'s doc comment for why).
 * Pairing a session's reply-producing segments with that same agent's own
 * posted messages, in chronological order, is reliable even though not
 * every turn results in a reply — turns that go silent are simply excluded
 * from both lists, so the pairing stays 1:1.
 *
 * Pairing is scoped by `actorId` + "posted at/after this session started",
 * NOT `messages.sessionId` — that column only gets populated when an agent's
 * MCP connection is stdio (env-var based, per container); the platform MCP
 * preset most agents actually use is HTTP-transport against the shared
 * backend process, where there's no single "current session" to read from
 * `process.env`, so `sessionId` comes back null for those replies. Only one
 * session can be active per (conversation, agent actor) at a time (enforced
 * by `sessions_conversation_actor_active_uniq`), and a new session can only
 * start once the previous one for that pair is terminal — so every message
 * this actor posted at or after `session.startedAt` unambiguously belongs to
 * this session, with no risk of pulling in an older, already-dead session's
 * messages.
 */
export function useConversationActivity(
	workspaceId: string,
	conversationId: string | null,
	messages: MessageResponse[],
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

	const byReplyMessageId = new Map<number, MessageTurnActivity[]>()
	const byTriggerMessageId = new Map<number, MessageTurnActivity[]>()
	const fallback: MessageTurnActivity[] = []

	activeSessions.forEach((session, sessionIndex) => {
		const logs = logsQueries[sessionIndex]?.data ?? []
		const { segments, unassigned } = segmentActivityByMessage(logs)
		const idle = isSessionIdleAwaitingInput(logs)

		const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : null
		const agentMessages = messages.filter((m) => {
			if (m.actorId !== session.actorId) return false
			if (startedAt === null || !m.createdAt) return true
			return new Date(m.createdAt).getTime() >= startedAt
		})
		const replySegments = segments.filter((s) => s.containsReply)
		const pairedCount = Math.min(replySegments.length, agentMessages.length)
		for (let i = 0; i < pairedCount; i++) {
			const message = agentMessages[i]
			const segment = replySegments[i]
			if (!message || !segment) continue
			const list = byReplyMessageId.get(message.id) ?? []
			list.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: segment.steps,
				inProgress: false,
			})
			byReplyMessageId.set(message.id, list)
		}

		// The live turn is the last segment overall, unless it's already one
		// of the reply segments we just paired off above (already resolved).
		const lastSegment = segments[segments.length - 1]
		const lastSegmentPairedIndex = lastSegment ? replySegments.indexOf(lastSegment) : -1
		const lastSegmentAlreadyPaired =
			lastSegmentPairedIndex !== -1 && lastSegmentPairedIndex < pairedCount

		if (!idle && lastSegment && !lastSegmentAlreadyPaired) {
			const list = byTriggerMessageId.get(lastSegment.conversationMessageId) ?? []
			list.push({
				sessionId: session.id,
				actorId: session.actorId,
				steps: lastSegment.steps,
				inProgress: true,
			})
			byTriggerMessageId.set(lastSegment.conversationMessageId, list)
		}

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

	return { byReplyMessageId, byTriggerMessageId, fallback }
}
