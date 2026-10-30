import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useEffect, useRef } from 'react'

/**
 * Marks the newest loaded message read once it is in, mirroring the "open = read"
 * convention used elsewhere (subscriptions markRead on open). It reads the UNFILTERED
 * list on purpose: the conversation's unread count includes replies, so the cursor has
 * to advance past a reply that hides inside a thread, not stop at the last top-level
 * message.
 */
export function useMarkConversationRead(conversationId: string, workspaceId: string) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const { data: messagesData } = useConversationMessages(conversationId, workspaceId)
	const updateMe = useUpdateConversationMe(workspaceId)
	const lastMarkedRef = useRef<number | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: updateMe is a stable mutation handle; including it would rerun this on every render without changing behavior
	useEffect(() => {
		if (!conversation) return
		const messages = flattenMessagesOldestFirst(messagesData)
		const newest = messages[messages.length - 1]
		if (!newest || newest.id <= 0) return
		if (newest.id === conversation.last_read_message_id) return
		if (lastMarkedRef.current === newest.id) return
		lastMarkedRef.current = newest.id
		updateMe.mutate({ id: conversationId, data: { last_read_message_id: newest.id } })
	}, [conversation, messagesData, conversationId])
}
