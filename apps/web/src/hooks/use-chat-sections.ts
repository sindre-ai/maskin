import { type ChatSectionResponse, type ChatSectionsResponse, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/** The viewer's own sections, in order. Personal: the server only ever returns the caller's. */
export function useChatSections(workspaceId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.chatSections.all(workspaceId),
		queryFn: () => api.chatSections.list(workspaceId),
		enabled: !!workspaceId && (options?.enabled ?? true),
	})
}

type Snapshot = { previous: ChatSectionsResponse | undefined }

/** Runs `change` on the cached sections right away; the server's answer settles it. A failure
 *  puts the old list back. */
function useSectionMutation<TVariables, TResult = unknown>(
	workspaceId: string,
	mutationFn: (variables: TVariables) => Promise<TResult>,
	change?: (sections: ChatSectionResponse[], variables: TVariables) => ChatSectionResponse[],
) {
	const queryClient = useQueryClient()
	const key = queryKeys.chatSections.all(workspaceId)
	return useMutation<TResult, Error, TVariables, Snapshot>({
		mutationFn,
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: key })
			const previous = queryClient.getQueryData<ChatSectionsResponse>(key)
			if (previous && change) {
				queryClient.setQueryData<ChatSectionsResponse>(key, {
					sections: change(previous.sections, variables),
				})
			}
			return { previous }
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) queryClient.setQueryData(key, context.previous)
		},
		onSettled: () => refreshChatList(queryClient, workspaceId),
	})
}

/** A chat's section is on the list rows too, so the list refreshes with the sections. */
function refreshChatList(queryClient: QueryClient, workspaceId: string) {
	queryClient.invalidateQueries({ queryKey: queryKeys.chatSections.all(workspaceId) })
	queryClient.invalidateQueries({
		queryKey: queryKeys.conversations.listInfinitePrefix(workspaceId),
	})
}

/** Takes a chat out of every section, then puts it in `sectionId` when one is given. */
function placeChat(
	sections: ChatSectionResponse[],
	conversationId: string,
	sectionId: string | null,
): ChatSectionResponse[] {
	return sections.map((s) => {
		const without = s.conversationIds.filter((id) => id !== conversationId)
		return {
			...s,
			conversationIds: s.id === sectionId ? [...without, conversationId] : without,
		}
	})
}

export function useCreateChatSection(workspaceId: string) {
	return useSectionMutation(workspaceId, (data: { name: string }) =>
		api.chatSections.create(workspaceId, data),
	)
}

export function useUpdateChatSection(workspaceId: string) {
	return useSectionMutation(
		workspaceId,
		({ id, data }: { id: string; data: { name?: string; collapsed?: boolean } }) =>
			api.chatSections.update(id, workspaceId, data),
		(sections, { id, data }) => sections.map((s) => (s.id === id ? { ...s, ...data } : s)),
	)
}

export function useDeleteChatSection(workspaceId: string) {
	return useSectionMutation(
		workspaceId,
		(id: string) => api.chatSections.remove(id, workspaceId),
		(sections, id) => sections.filter((s) => s.id !== id),
	)
}

export function useReorderChatSections(workspaceId: string) {
	return useSectionMutation(
		workspaceId,
		(ids: string[]) => api.chatSections.reorder(workspaceId, ids),
		(sections, ids) =>
			ids
				.map((id, position) => {
					const found = sections.find((s) => s.id === id)
					return found ? { ...found, position } : null
				})
				.filter((s): s is ChatSectionResponse => s !== null),
	)
}

/** Moves a chat into a section, or back to the list when `sectionId` is null. */
export function useMoveChatToSection(workspaceId: string) {
	return useSectionMutation(
		workspaceId,
		async ({
			conversationId,
			sectionId,
			fromSectionId,
		}: {
			conversationId: string
			sectionId: string | null
			/** The section the chat leaves, needed to take it out when `sectionId` is null. */
			fromSectionId?: string | null
		}) => {
			if (sectionId) return api.chatSections.addChat(sectionId, conversationId, workspaceId)
			if (fromSectionId) {
				return api.chatSections.removeChat(fromSectionId, conversationId, workspaceId)
			}
		},
		(sections, { conversationId, sectionId }) => placeChat(sections, conversationId, sectionId),
	)
}
