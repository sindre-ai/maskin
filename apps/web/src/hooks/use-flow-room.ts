import {
	flattenMessagesOldestFirst,
	useConversationMessages,
	useSendMessage,
} from '@/hooks/use-conversation'
import { useCreateConversation } from '@/hooks/use-conversations'
import { useMarkConversationRead } from '@/hooks/use-mark-conversation-read'
import { api } from '@/lib/api'
import type { MessageResponse, PostMessageInput } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { queryKeys } from '@/lib/query-keys'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

/**
 * The chat a flow's room is built on: the one whose subject is the flow, or null while nobody
 * has said anything in the room. A chat the person archived is still the room, so it is looked
 * for too.
 */
function useFlowRoomChatId(workspaceId: string, flowId: string) {
	return useQuery({
		queryKey: queryKeys.conversations.flowRoom(workspaceId, flowId),
		queryFn: async () => {
			for (const archived of [false, true]) {
				const { conversations } = await api.conversations.list(workspaceId, {
					subject_type: 'object',
					subject_id: flowId,
					limit: '1',
					...(archived ? { archived: 'true' } : {}),
				})
				if (conversations[0]) return conversations[0].id
			}
			return null
		},
		enabled: !!workspaceId && !!flowId,
	})
}

/** A reply that was not also sent to the main timeline lives in its thread, not in the room. */
function isRoomMessage(message: MessageResponse) {
	return !message.threadRootId || message.threadAlsoInChannel === true
}

/**
 * The messages of a flow's room, and the way to add one. The room is read as a merge: these
 * messages sit beside the flow's old comments and its events on the flow page, and the page
 * leaves out a message or comment that is only a copy of the other. The chat is made on the
 * first post, with the flow's driver agent in it so someone answers.
 */
export function useFlowRoom(
	workspaceId: string,
	flow: { id: string; name: string | null },
	options: { agentId: string | null; active: boolean },
) {
	const queryClient = useQueryClient()
	const chatQuery = useFlowRoomChatId(workspaceId, flow.id)
	const chatId = chatQuery.data ?? null
	const messagesQuery = useConversationMessages(chatId ?? '', workspaceId, {
		enabled: !!chatId,
	})
	const createChat = useCreateConversation(workspaceId)
	const sendMessage = useSendMessage(chatId ?? '', workspaceId)
	// Opening the room reads it, as opening any chat does.
	useMarkConversationRead(options.active && chatId ? chatId : '', workspaceId)

	const messages = useMemo(
		() => flattenMessagesOldestFirst(messagesQuery.data).filter(isRoomMessage),
		[messagesQuery.data],
	)

	const post = useCallback(
		async (content: string, mentions: string[] = []) => {
			const self = getStoredActor()?.id
			const tagged = mentions.filter((id) => id !== self)
			const input: PostMessageInput = {
				content,
				...(tagged.length > 0 ? { metadata: { mentions: tagged } } : {}),
			}
			if (chatId) {
				await sendMessage.mutateAsync(input)
				return
			}
			// Asking again for the flow's chat returns the one that exists, so two people
			// posting first at once end up in the same room.
			const created = await createChat.mutateAsync({
				title: flow.name?.trim() || 'Flow room',
				participant_actor_ids: options.agentId ? [options.agentId] : [],
				subject: { type: 'object', id: flow.id },
			})
			await api.conversations.postMessage(created.id, workspaceId, input)
			queryClient.setQueryData(queryKeys.conversations.flowRoom(workspaceId, flow.id), created.id)
			await queryClient.invalidateQueries({
				queryKey: queryKeys.conversations.messagesPrefix(created.id),
			})
		},
		[
			chatId,
			createChat,
			flow.id,
			flow.name,
			options.agentId,
			queryClient,
			sendMessage,
			workspaceId,
		],
	)

	return {
		chatId,
		messages,
		// Not knowing the chat yet is not the same as having none.
		isLoading: chatQuery.isLoading || (!!chatId && messagesQuery.isLoading),
		isError: chatQuery.isError || messagesQuery.isError,
		refetch: () => {
			if (chatQuery.isError) void chatQuery.refetch()
			if (messagesQuery.isError) void messagesQuery.refetch()
		},
		hasEarlier: messagesQuery.hasNextPage === true,
		loadingEarlier: messagesQuery.isFetchingNextPage,
		loadEarlier: () => void messagesQuery.fetchNextPage(),
		post,
	}
}
