import { type ObjectGraphResponse, type ObjectResponse, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Live list of subscribers for an entity. Used by the watchers avatar stack.
 */
export function useSubscribers(workspaceId: string, entityType: string, entityId: string) {
	return useQuery({
		queryKey: queryKeys.subscriptions.subscribers(entityType, entityId),
		queryFn: () => api.subscriptions.subscribers(workspaceId, entityType, entityId),
		enabled: !!entityId,
	})
}

/**
 * Pulse-feed of entities with unread comments for the current actor.
 */
export function useUnread(workspaceId: string, entityType?: string) {
	return useQuery({
		queryKey: queryKeys.subscriptions.unread(workspaceId, entityType),
		queryFn: () => api.subscriptions.unread(workspaceId, entityType),
		enabled: !!workspaceId,
	})
}

export function useSubscribe(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ entityType, entityId }: { entityType: string; entityId: string }) =>
			api.subscriptions.subscribe(workspaceId, entityType, entityId),
		onSuccess: (_, { entityType, entityId }) => {
			// Refresh subscriber stack + object detail (subscriber_count + is_subscribed).
			queryClient.invalidateQueries({
				queryKey: queryKeys.subscriptions.subscribers(entityType, entityId),
			})
			if (entityType === 'object') {
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(entityId) })
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(entityId) })
			}
			queryClient.invalidateQueries({
				queryKey: queryKeys.subscriptions.unread(workspaceId),
			})
		},
	})
}

export function useUnsubscribe(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ entityType, entityId }: { entityType: string; entityId: string }) =>
			api.subscriptions.unsubscribe(workspaceId, entityType, entityId),
		onSuccess: (_, { entityType, entityId }) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.subscriptions.subscribers(entityType, entityId),
			})
			if (entityType === 'object') {
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(entityId) })
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(entityId) })
			}
			queryClient.invalidateQueries({
				queryKey: queryKeys.subscriptions.unread(workspaceId),
			})
		},
	})
}

/**
 * Mark an entity as read up to `lastEventId`. Optimistically zeroes the cached
 * unread_count on the object detail/graph so the badge disappears immediately;
 * server is the source of truth on the next refetch.
 */
export function useMarkRead(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			entityType,
			entityId,
			lastEventId,
		}: {
			entityType: string
			entityId: string
			lastEventId: number
		}) => api.subscriptions.markRead(workspaceId, entityType, entityId, lastEventId),
		onMutate: async ({ entityType, entityId }) => {
			if (entityType !== 'object') return
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.detail(entityId) })
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.graph(entityId) })

			const previousDetail = queryClient.getQueryData<ObjectResponse>(
				queryKeys.objects.detail(entityId),
			)
			if (previousDetail) {
				queryClient.setQueryData(queryKeys.objects.detail(entityId), {
					...previousDetail,
					unread_count: 0,
				})
			}
			const previousGraph = queryClient.getQueryData<ObjectGraphResponse>(
				queryKeys.objects.graph(entityId),
			)
			if (previousGraph) {
				queryClient.setQueryData(queryKeys.objects.graph(entityId), {
					...previousGraph,
					object: { ...previousGraph.object, unread_count: 0 },
				})
			}
			return { previousDetail, previousGraph }
		},
		onError: (_err, { entityType, entityId }, context) => {
			if (entityType !== 'object' || !context) return
			if (context.previousDetail) {
				queryClient.setQueryData(queryKeys.objects.detail(entityId), context.previousDetail)
			}
			if (context.previousGraph) {
				queryClient.setQueryData(queryKeys.objects.graph(entityId), context.previousGraph)
			}
		},
		onSettled: (_data, _err, { entityType, entityId }) => {
			if (entityType === 'object') {
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(entityId) })
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(entityId) })
			}
			queryClient.invalidateQueries({
				queryKey: queryKeys.subscriptions.unread(workspaceId),
			})
		},
	})
}
