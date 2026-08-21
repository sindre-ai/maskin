import { parseFailureReason } from '@/components/agents/session-detail-panel'
import type { ActivityStep } from '@/components/agents/session-log-transcript'
import {
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
} from '@/components/agents/session-log-transcript'
import type { MessageResponse, SessionResponse } from '@/lib/api'
import { useSessionActivityLogs } from './use-session-activity-logs'
import { useActiveSessionsForConversation } from './use-sessions'

export interface MessageTurnActivity {
	sessionId: string
	actorId: string
	steps: ActivityStep[]
	/** True for the single most recent turn of a session that hasn't reached a `result` envelope yet. */
	inProgress: boolean
	/** True when the session that would have produced this turn failed before (or shortly after) starting. */
	failed?: boolean
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
	 * A still-in-progress turn's live dropdown, or a failed session's error
	 * notice, keyed by the message that triggered it — there's no reply yet
	 * (and never will be, if failed) to anchor it to instead. A live turn
	 * moves to `byReplyMessageId` once it posts a reply; if it resolves
	 * without posting one ("no action needed"), it just disappears. A failed
	 * turn stays put until the actor's next session for this conversation
	 * supersedes it (see the "latest session per actor" filtering above).
	 */
	byTriggerMessageId: Map<number, MessageTurnActivity[]>
	/**
	 * A still-in-progress turn whose `maskin_message_id` tag hasn't been
	 * logged yet (the brief window right after a turn starts), an older
	 * session whose turns predate message-id tagging, or a failed session
	 * whose `config.conversation.message_id` wasn't set. The caller should
	 * attach these to the newest message in the thread so something still
	 * shows immediately, matching the old "typing indicator" behavior for
	 * this edge case.
	 */
	fallback: MessageTurnActivity[]
}

/**
 * Segments the conversation's most recent session per agent into per-message
 * activity turns: a running session's turns are split from its logs and
 * re-anchored to the reply message they produced (see `byReplyMessageId`'s
 * doc comment for why); a failed session — whether it died before ever
 * reaching `running` (dispatch/enqueue failure) or ran for a while and then
 * failed (e.g. classified credit/rate-limit exhaustion) — instead surfaces a
 * single error notice anchored to the message that triggered it, otherwise a
 * failed session is invisible to the chat UI. Pairing a running session's
 * reply-producing segments with that same agent's own posted messages, in
 * chronological order, is reliable even though not every turn results in a
 * reply — turns that go silent are simply excluded from both lists, so the
 * pairing stays 1:1.
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

	// Sessions come back newest-first (see the route's `orderBy(desc(sessions.createdAt))`)
	// — keep only the latest session per agent, since that's the one whose
	// status actually reflects "what's happening now" for that agent. An
	// older failed attempt for an actor who has since retried (or replied
	// successfully) shouldn't keep showing a stale failure notice.
	const latestByActor = new Map<string, SessionResponse>()
	for (const session of sessions ?? []) {
		if (!latestByActor.has(session.actorId)) latestByActor.set(session.actorId, session)
	}
	const latestSessions = [...latestByActor.values()]
	const activeSessions = latestSessions.filter((s) => s.status === 'running')
	// 'timeout' is deliberately NOT surfaced. The 2-hour backstop
	// (session-manager.ts's reaper) is expected lifecycle, not a failure: the
	// next message in this conversation spawns a fresh interactive session
	// seeded with the recent history (see conversation-responder.ts's
	// spawnConversationSession), so the user never loses context and has
	// nothing to act on. Showing "failed to start / Session timed out" for it
	// was alarming noise. Genuine failures ('failed') still surface.
	const failedSessions = latestSessions.filter((s) => s.status === 'failed')

	const logsQueries = useSessionActivityLogs(
		workspaceId,
		activeSessions.map((s) => s.id),
	)

	const byReplyMessageId = new Map<number, MessageTurnActivity[]>()
	const byTriggerMessageId = new Map<number, MessageTurnActivity[]>()
	const fallback: MessageTurnActivity[] = []

	for (const session of failedSessions) {
		const config = session.config as { conversation?: { message_id?: number } } | null
		const messageId = config?.conversation?.message_id
		// A session that reached `running` and later died from classified credit/rate-limit
		// exhaustion carries its message in `result.failure_reason.human_message`, not
		// `result.error` (see classifyCreditExhaustion() in session-manager.ts) — prefer
		// that curated message when present, since it's specific (e.g. "credit balance
		// exhausted") rather than the generic "could not be started" fallback copy.
		const errorText =
			parseFailureReason(session.result)?.human_message ||
			(typeof session.result?.error === 'string' ? session.result.error : undefined)
		const turn: MessageTurnActivity = {
			sessionId: session.id,
			actorId: session.actorId,
			steps: errorText ? [{ id: `${session.id}-error`, kind: 'error', text: errorText }] : [],
			inProgress: false,
			failed: true,
		}
		if (typeof messageId === 'number') {
			const list = byTriggerMessageId.get(messageId) ?? []
			list.push(turn)
			byTriggerMessageId.set(messageId, list)
		} else {
			fallback.push(turn)
		}
	}

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
