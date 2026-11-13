import { getStoredActor } from '@/lib/auth'
import { type ChatListView, getStoredChatListView, persistChatListView } from '@/lib/chat-list-view'
import { useCallback, useState } from 'react'

/** The Chats list view (Agents or Recent), remembered per person on this device. */
export function useChatListView() {
	const actorId = getStoredActor()?.id
	const [view, setViewState] = useState<ChatListView>(() => getStoredChatListView(actorId))
	const setView = useCallback(
		(next: ChatListView) => {
			setViewState(next)
			persistChatListView(actorId, next)
		},
		[actorId],
	)
	return { view, setView }
}
