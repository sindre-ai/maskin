import {
	ApiError,
	type DisplaySettingsBody,
	type UserDisplaySettingsResponse,
	api,
} from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

/**
 * Read the current actor's persisted display settings for a single object
 * type. Returns `null` (not undefined) when the server has no row yet so
 * callers can distinguish "still loading" from "no settings persisted".
 */
export function useUserDisplaySettings(workspaceId: string, objectType: string) {
	return useQuery<UserDisplaySettingsResponse | null>({
		queryKey: queryKeys.userDisplaySettings.detail(workspaceId, objectType),
		queryFn: async () => {
			try {
				return await api.userDisplaySettings.get(workspaceId, objectType)
			} catch (err) {
				if (err instanceof ApiError && err.status === 404) return null
				throw err
			}
		},
		enabled: !!workspaceId && !!objectType,
	})
}

/**
 * Upsert the current actor's display settings for one object type.
 * Optimistically replaces the cached blob so the panel doesn't visibly
 * "snap back" between the user's tweak and the server round-trip.
 */
export function useUpdateUserDisplaySettings(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			objectType,
			settings,
		}: {
			objectType: string
			settings: DisplaySettingsBody
		}) => api.userDisplaySettings.upsert(workspaceId, objectType, settings),
		onMutate: async ({ objectType, settings }) => {
			const detailKey = queryKeys.userDisplaySettings.detail(workspaceId, objectType)
			await queryClient.cancelQueries({ queryKey: detailKey })
			const previous = queryClient.getQueryData<UserDisplaySettingsResponse | null>(detailKey)
			const optimistic: UserDisplaySettingsResponse = {
				object_type: objectType,
				name: previous?.name ?? 'default',
				settings,
				updated_at: new Date().toISOString(),
			}
			queryClient.setQueryData<UserDisplaySettingsResponse | null>(detailKey, optimistic)
			return { previous }
		},
		onError: (_err, { objectType }, context) => {
			if (context?.previous === undefined) return
			queryClient.setQueryData(
				queryKeys.userDisplaySettings.detail(workspaceId, objectType),
				context.previous,
			)
		},
		onSettled: (_data, _err, { objectType }) => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.userDisplaySettings.detail(workspaceId, objectType),
			})
			queryClient.invalidateQueries({ queryKey: queryKeys.userDisplaySettings.list(workspaceId) })
		},
	})
}
