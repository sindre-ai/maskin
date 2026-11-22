import { trackChatFirstReplyReceived, trackChatLeft, trackChatMessageResent } from '@/lib/analytics'
import type { MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useEffect, useRef } from 'react'

interface Visit {
	conversationId: string
	/** Counts when the chat was opened, so history from earlier visits is not claimed. */
	baselineMine: number
	baselineAgent: number
	mine: number
	agent: number
	firstReplySent: boolean
	/**
	 * How many of their messages were already checked for a re-send. Counted by position, not
	 * id: a sent message first shows as a row with a temporary id, then as the server's row.
	 */
	resentChecked: number
}

/** A second message inside this window, with no answer in between, counts as sent again. */
const RESEND_WINDOW_MS = 60_000

function countMessages(messages: MessageResponse[], myActorId: string | null) {
	let mine = 0
	let agent = 0
	let lastMineAt: number | null = null
	let firstAgentSessionId: string | null = null
	const mineSent: number[] = []
	const agentAt: number[] = []
	for (const m of messages) {
		if (m.kind !== 'message') continue
		const at = m.createdAt ? Date.parse(m.createdAt) : Number.NaN
		if (m.actorType === 'agent') {
			agent += 1
			if (agent === 1) firstAgentSessionId = m.sessionId
			if (!Number.isNaN(at)) agentAt.push(at)
		} else if (myActorId && m.actorId === myActorId) {
			mine += 1
			if (!Number.isNaN(at)) {
				mineSent.push(at)
				if (lastMineAt === null || at > lastMineAt) lastMineAt = at
			}
		}
	}
	return { mine, agent, lastMineAt, firstAgentSessionId, mineSent, agentAt }
}

/**
 * Three chat events for the visit to one conversation, from the messages the page
 * already holds:
 * - `chat_first_reply_received`: an agent answered a chat that had no agent
 *   message when the person opened it, and they have written in it.
 * - `chat_left`: the person leaves a chat they wrote in during this visit, as
 *   `replied` (an agent message arrived since they opened it) or `abandoned`.
 *   Closing the tab sends nothing: only leaving the chat inside the app does.
 * - `chat_message_resent`: the person wrote again within 60 seconds of their
 *   previous message, before any agent answered it. Derived from message times.
 */
export function useChatOutcomeTracking(
	conversationId: string,
	messages: MessageResponse[],
	loaded: boolean,
): void {
	const visitRef = useRef<Visit | null>(null)

	useEffect(() => {
		if (!loaded) return
		const { mine, agent, lastMineAt, firstAgentSessionId, mineSent, agentAt } = countMessages(
			messages,
			getStoredActor()?.id ?? null,
		)
		const visit = visitRef.current
		if (!visit || visit.conversationId !== conversationId) {
			visitRef.current = {
				conversationId,
				baselineMine: mine,
				baselineAgent: agent,
				mine,
				agent,
				firstReplySent: false,
				resentChecked: 0,
			}
			return
		}
		visit.mine = mine
		visit.agent = agent
		if (!visit.firstReplySent && visit.baselineAgent === 0 && agent > 0 && mine > 0) {
			visit.firstReplySent = true
			trackChatFirstReplyReceived({
				entity_id: conversationId,
				latency_ms: lastMineAt === null ? null : Math.max(0, Date.now() - lastMineAt),
				session_id: firstAgentSessionId,
			})
		}
		// Only messages written after the chat was opened count, and only a message that
		// follows another of theirs with no agent message in between.
		for (let i = Math.max(1, visit.baselineMine, visit.resentChecked); i < mineSent.length; i++) {
			const previous = mineSent[i - 1]
			const current = mineSent[i]
			if (!previous || !current) continue
			const gapMs = current - previous
			if (gapMs < 0 || gapMs > RESEND_WINDOW_MS) continue
			if (agentAt.some((at) => at >= previous && at <= current)) continue
			trackChatMessageResent({
				entity_id: conversationId,
				seconds_since_previous: Math.round(gapMs / 1000),
			})
		}
		visit.resentChecked = mineSent.length
	}, [conversationId, messages, loaded])

	useEffect(
		() => () => {
			const visit = visitRef.current
			visitRef.current = null
			if (!visit || visit.conversationId !== conversationId) return
			if (visit.mine <= visit.baselineMine) return
			trackChatLeft({
				entity_id: conversationId,
				outcome: visit.agent > visit.baselineAgent ? 'replied' : 'abandoned',
			})
		},
		[conversationId],
	)
}
