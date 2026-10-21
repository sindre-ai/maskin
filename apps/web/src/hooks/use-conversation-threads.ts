import { flattenMessagesOldestFirst, useConversationMessages } from '@/hooks/use-conversation'
import type { SpawnedSession } from '@/lib/api'
import { useMemo } from 'react'

export interface ConversationThread extends SpawnedSession {
	/** The assistant message whose handoff spawned this session; null until one carries it. */
	messageId: number | null
}

/**
 * Every sub-session handed off from a chat, newest state wins, oldest first.
 * Derived from the `spawned_sessions` embed on the already-loaded messages, so
 * it adds no request and stays live with the transcript (the SSE
 * `session.state_changed` frame patches that same cache).
 */
export function useConversationThreads(workspaceId: string, conversationId: string) {
	const { data } = useConversationMessages(conversationId, workspaceId)
	return useMemo(() => {
		const byId = new Map<string, ConversationThread>()
		for (const message of flattenMessagesOldestFirst(data)) {
			for (const session of message.spawned_sessions ?? []) {
				byId.set(session.id, { ...session, messageId: message.id })
			}
		}
		// Handoffs no message carries yet (the agent started them and has not
		// narrated them). Only the newest page carries them, and `pages[0]` is it.
		for (const session of data?.pages[0]?.pending_handoffs ?? []) {
			if (!byId.has(session.id)) byId.set(session.id, { ...session, messageId: null })
		}
		return Array.from(byId.values())
	}, [data])
}
