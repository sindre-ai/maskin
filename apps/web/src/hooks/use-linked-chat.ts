import { useConversation } from '@/hooks/use-conversation'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { ApiError, type ConversationParticipantResponse } from '@/lib/api'

/** What a chat card or chip shows about a chat. */
export interface LinkedChat {
	id: string
	title: string
	pinned: boolean
	archived: boolean
	updatedAt: string | null
	participants: ConversationParticipantResponse[]
	/** The last message as the list holds it. Null for a chat read by id, which carries no message, and for an empty chat. */
	lastMessage: { text: string; authorId: string | null; authorName: string | null } | null
}

/**
 * The chat a link points at: `undefined` while it loads, `null` when it cannot be shown (not
 * found, or not yours to read: the two are not told apart), else the chat. It reads the chat list
 * the sidebar holds first, which has the last message; a chat that is not in the loaded page is
 * read by id, which has everything but the last message. The list is one request shared by every
 * link, and the read by id happens only for a chat the list does not have.
 */
export function useLinkedChat(workspaceId: string, chatId: string): LinkedChat | null | undefined {
	// The same filters as the sidebar's "All", so this is the sidebar's cache entry.
	const list = useConversationsInfinite(workspaceId, {})
	const row = list.data?.pages
		.flatMap((page) => page.conversations)
		.find((conversation) => conversation.id === chatId)
	const detail = useConversation(chatId, workspaceId, { enabled: !list.isLoading && !row })

	if (row) {
		return {
			id: row.id,
			title: row.title,
			pinned: row.pinned,
			archived: row.archived,
			updatedAt: row.lastMessageAt ?? row.updatedAt,
			participants: row.participants,
			lastMessage: row.snippet
				? { text: row.snippet, authorId: row.snippet_actor_id, authorName: row.snippet_actor_name }
				: null,
		}
	}
	if (detail.data) {
		if (detail.data.workspaceId !== workspaceId) return null
		return {
			id: detail.data.id,
			title: detail.data.title,
			pinned: detail.data.pinned,
			archived: detail.data.archived,
			updatedAt: detail.data.lastMessageAt ?? detail.data.updatedAt,
			participants: detail.data.participants,
			lastMessage: null,
		}
	}
	// A refusal is the answer; any other failure (the network, the server) says nothing about the chat.
	if (detail.error instanceof ApiError && detail.error.status >= 400 && detail.error.status < 500) {
		return null
	}
	return undefined
}
