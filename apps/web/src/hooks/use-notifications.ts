import { type NotificationResponse, type UpdateNotificationInput, api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export function useNotifications(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.notifications.list(workspaceId, filters),
		queryFn: () => api.notifications.list(workspaceId, filters),
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

export function useObjectNotifications(workspaceId: string, objectId: string) {
	const { data, ...rest } = useNotifications(workspaceId, {
		object_id: objectId,
		type: 'needs_input',
	})
	const pending = data?.filter((n) => n.status === 'pending' || n.status === 'seen')
	return { data: pending, ...rest }
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
