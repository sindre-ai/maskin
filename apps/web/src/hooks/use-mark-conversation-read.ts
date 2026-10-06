import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useEffect, useRef } from 'react'

/** "Open = read": advances the read marker to the newest loaded message. */
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
