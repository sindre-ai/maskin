import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { useSessionChainLogs } from '@/hooks/use-sessions'
import type { MessageResponse } from '@/lib/api'
import { buildThreadChat } from '@/lib/session-thread'
import { useMemo } from 'react'

const NOBODY = { id: '', name: '', type: 'agent' as const }

/**
 * The thinking and tool calls behind replies that were copied into a chat from a background
 * run. Those replies were not posted live, so the chat's own activity (which follows the chat's
 * sessions and their tagged turns) has nothing for them; the run's log does. Each copied reply is
 * paired, in order, with the reply the log shows for that run.
 */
export function useBackfilledRunActivity(
	workspaceId: string,
	messages: MessageResponse[],
): Map<number, MessageTurnActivity[]> {
	const copiedBySession = useMemo(() => {
		const bySession = new Map<string, MessageResponse[]>()
		for (const m of messages) {
			if (!m.sessionId || !m.metadata?.final_output?.backfilled) continue
			const list = bySession.get(m.sessionId) ?? []
			list.push(m)
			bySession.set(m.sessionId, list)
		}
		return bySession
	}, [messages])

	const sessionIds = useMemo(() => [...copiedBySession.keys()], [copiedBySession])
	const logs = useSessionChainLogs(sessionIds, workspaceId)
	const loaded = logs.map((q) => q.data)
	// A change in what the logs hold, so the pairing is redone only then and not on every render.
	const loadedKey = logs.map((q) => q.dataUpdatedAt).join(',')

	// biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` is rebuilt every render; `loadedKey` says when its contents changed
	return useMemo(() => {
		const byMessage = new Map<number, MessageTurnActivity[]>()
		sessionIds.forEach((sessionId, i) => {
			const data = loaded[i]
			if (!data) return
			const copied = copiedBySession.get(sessionId) ?? []
			const first = copied[0]
			if (!first) return
			const { items } = buildThreadChat(data, {
				conversationId: first.conversationId,
				sessionId,
				agent: { id: first.actorId, name: first.actorName, type: 'agent' },
				me: NOBODY,
				prompt: { author: NOBODY, content: '', createdAt: null },
			})
			const replies = items.filter((item) => item.message.actorId === first.actorId)
			copied.forEach((message, index) => {
				const steps = replies[index]?.steps ?? []
				if (steps.length === 0) return
				byMessage.set(message.id, [
					{ sessionId, actorId: message.actorId, steps, inProgress: false },
				])
			})
		})
		return byMessage
	}, [sessionIds, copiedBySession, loadedKey])
}
