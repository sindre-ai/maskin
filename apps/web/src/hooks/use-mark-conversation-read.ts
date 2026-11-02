import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useMarkNewestRead } from '@/hooks/use-mark-newest-read'
import { useMemo } from 'react'

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

	const newestMessageId = useMemo(() => {
		const messages = flattenMessagesOldestFirst(messagesData)
		return messages[messages.length - 1]?.id ?? 0
	}, [messagesData])
	useMarkNewestRead(
		conversation && newestMessageId > 0 && newestMessageId !== conversation.last_read_message_id
			? newestMessageId
			: null,
		(messageId) =>
			updateMe.mutateAsync({ id: conversationId, data: { last_read_message_id: messageId } }),
	)
}
