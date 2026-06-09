import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConversationResponse, CreateConversationInput } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useConversations(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.conversations.all(workspaceId),
		queryFn: () => api.conversations.list(workspaceId),
		enabled: !!workspaceId,
	})
}

export function useConversationMessages(workspaceId: string, conversationId: string | null) {
	return useQuery({
		queryKey: queryKeys.conversations.messages(conversationId ?? ''),
		queryFn: () => api.conversations.messages(workspaceId, conversationId!),
		enabled: !!workspaceId && !!conversationId,
	})
}

export function useCreateConversation(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateConversationInput) =>
			api.conversations.create(workspaceId, data),
		onSuccess: (created: ConversationResponse) => {
			queryClient.setQueryData<ConversationResponse[]>(
				queryKeys.conversations.all(workspaceId),
				(prev) => (prev ? [created, ...prev] : [created]),
			)
		},
	})
}
