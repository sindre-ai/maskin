import { trackChatFirstReplyReceived, trackChatLeft } from '@/lib/analytics'
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
}

function countMessages(messages: MessageResponse[], myActorId: string | null) {
	let mine = 0
	let agent = 0
	let lastMineAt: number | null = null
	for (const m of messages) {
		if (m.kind !== 'message') continue
		if (m.actorType === 'agent') {
			agent += 1
		} else if (myActorId && m.actorId === myActorId) {
			mine += 1
			const at = m.createdAt ? Date.parse(m.createdAt) : Number.NaN
			if (!Number.isNaN(at) && (lastMineAt === null || at > lastMineAt)) lastMineAt = at
		}
	}
	return { mine, agent, lastMineAt }
}

/**
 * Two chat events for the visit to one conversation, from the messages the page
 * already holds:
 * - `chat_first_reply_received`: an agent answered a chat that had no agent
 *   message when the person opened it, and they have written in it.
 * - `chat_left`: the person leaves a chat they wrote in during this visit, as
 *   `replied` (an agent message arrived since they opened it) or `abandoned`.
 *   Closing the tab sends nothing: only leaving the chat inside the app does.
 */
export function useChatOutcomeTracking(
	conversationId: string,
	messages: MessageResponse[],
	loaded: boolean,
): void {
	const visitRef = useRef<Visit | null>(null)

	useEffect(() => {
		if (!loaded) return
		const { mine, agent, lastMineAt } = countMessages(messages, getStoredActor()?.id ?? null)
		const visit = visitRef.current
		if (!visit || visit.conversationId !== conversationId) {
			visitRef.current = {
				conversationId,
				baselineMine: mine,
				baselineAgent: agent,
				mine,
				agent,
				firstReplySent: false,
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
			})
		}
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
