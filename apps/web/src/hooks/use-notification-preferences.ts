import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import type {
	NotificationPreferencesResponse,
	UpdateNotificationPreferencesInput,
} from '@maskin/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export function useNotificationPreferences() {
	return useQuery({
		queryKey: queryKeys.notificationPreferences.me,
		queryFn: () => api.notificationPreferences.get(),
	})
}

/** Optimistic upsert: the switch moves at once and rolls back if the save fails. */
export function useUpdateNotificationPreferences() {
	const queryClient = useQueryClient()
	const key = queryKeys.notificationPreferences.me
	return useMutation({
		mutationFn: (data: UpdateNotificationPreferencesInput) =>
			api.notificationPreferences.update(data),
		onMutate: async (data) => {
			await queryClient.cancelQueries({ queryKey: key })
			const previous = queryClient.getQueryData<NotificationPreferencesResponse>(key)
			if (previous) {
				queryClient.setQueryData<NotificationPreferencesResponse>(key, {
					...previous,
					...data,
					categories: { ...previous.categories, ...data.categories },
					browser_categories: { ...previous.browser_categories, ...data.browser_categories },
					browser_not_asked: previous.browser_not_asked.filter(
						(kind) => data.browser_categories?.[kind] === undefined,
					),
				})
			}
			return { previous }
		},
		onError: (_err, _data, ctx) => {
			if (ctx?.previous) queryClient.setQueryData(key, ctx.previous)
		},
		onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
	})
}
