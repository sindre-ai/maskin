import { type NotificationResponse, type UpdateNotificationInput, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export function useNotifications(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.notifications.list(workspaceId, filters),
		queryFn: () => api.notifications.list(workspaceId, filters),
	})
}

// For You feed feeds off `attention_needed=true` notifications only — everything
// else lives in the plain notification stream (subscriptions, mentions) and
// stays out of the queue per the parent bet AC.
export function useForYouNotifications(workspaceId: string) {
	const filters = { attention_needed: 'true', limit: '100' }
	return useQuery({
		queryKey: queryKeys.notifications.list(workspaceId, filters),
		queryFn: () => api.notifications.list(workspaceId, filters),
	})
}

// Bulk-respond wraps T3's POST /notifications/bulk-respond. The container calls
// this for a same-`objectId` group so N notifications resolve in one txn with
// exactly one wake per source agent.
export function useBulkRespondNotifications(workspaceId: string) {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: ({ ids, response }: { ids: string[]; response: unknown }) =>
			api.notifications.bulkRespond(ids, response, workspaceId),
		onMutate: async ({ ids }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all(workspaceId) })

			const previousQueries: [readonly unknown[], NotificationResponse[] | undefined][] = []
			const idSet = new Set(ids)
			const queries = queryClient.getQueriesData<NotificationResponse[]>({
				queryKey: queryKeys.notifications.all(workspaceId),
			})
			for (const [key, existing] of queries) {
				if (existing) {
					previousQueries.push([key, existing])
					queryClient.setQueryData(
						key,
						existing.map((n) => (idSet.has(n.id) ? { ...n, status: 'resolved' } : n)),
					)
				}
			}
			return { previousQueries }
		},
		onError: (_err, _vars, context) => {
			for (const [key, data] of context?.previousQueries ?? []) {
				queryClient.setQueryData(key, data)
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all(workspaceId) })
		},
	})
}

export function useUpdateNotification(workspaceId: string) {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateNotificationInput }) =>
			api.notifications.update(id, data),
		onMutate: async ({ id, data }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all(workspaceId) })

			const previousQueries: [readonly unknown[], NotificationResponse[] | undefined][] = []
			const queries = queryClient.getQueriesData<NotificationResponse[]>({
				queryKey: queryKeys.notifications.all(workspaceId),
			})
			for (const [key, existing] of queries) {
				if (existing) {
					previousQueries.push([key, existing])
					queryClient.setQueryData(
						key,
						existing.map((n) => (n.id === id ? { ...n, ...data } : n)),
					)
				}
			}
			return { previousQueries }
		},
		onError: (_err, _vars, context) => {
			for (const [key, data] of context?.previousQueries ?? []) {
				queryClient.setQueryData(key, data)
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all(workspaceId) })
		},
	})
}

export function useRespondNotification(workspaceId: string) {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: ({ id, response }: { id: string; response: unknown }) =>
			api.notifications.respond(id, response, workspaceId),
		onMutate: async ({ id }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all(workspaceId) })

			const previousQueries: [readonly unknown[], NotificationResponse[] | undefined][] = []
			const queries = queryClient.getQueriesData<NotificationResponse[]>({
				queryKey: queryKeys.notifications.all(workspaceId),
			})
			for (const [key, existing] of queries) {
				if (existing) {
					previousQueries.push([key, existing])
					queryClient.setQueryData(
						key,
						existing.map((n) => (n.id === id ? { ...n, status: 'resolved' } : n)),
					)
				}
			}
			return { previousQueries }
		},
		onError: (_err, _vars, context) => {
			for (const [key, data] of context?.previousQueries ?? []) {
				queryClient.setQueryData(key, data)
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all(workspaceId) })
		},
	})
}

export function useDeleteNotification(workspaceId: string) {
	const queryClient = useQueryClient()

	return useMutation({
		mutationFn: (id: string) => api.notifications.delete(id),
		onMutate: async (id) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.notifications.all(workspaceId) })

			const previousQueries: [readonly unknown[], NotificationResponse[] | undefined][] = []
			const queries = queryClient.getQueriesData<NotificationResponse[]>({
				queryKey: queryKeys.notifications.all(workspaceId),
			})
			for (const [key, existing] of queries) {
				if (existing) {
					previousQueries.push([key, existing])
					queryClient.setQueryData(
						key,
						existing.filter((n) => n.id !== id),
					)
				}
			}
			return { previousQueries }
		},
		onError: (_err, _id, context) => {
			for (const [key, data] of context?.previousQueries ?? []) {
				queryClient.setQueryData(key, data)
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all(workspaceId) })
		},
	})
}
