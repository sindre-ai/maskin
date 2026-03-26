import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CreateCommentInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useEvents(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.events.history(workspaceId, filters),
		queryFn: () => api.events.history(workspaceId, filters),
	})
}

export function useEntityEvents(workspaceId: string, entityId: string) {
	return useQuery({
		queryKey: queryKeys.events.byEntity(entityId),
		queryFn: () => api.events.history(workspaceId, { entity_id: entityId, limit: '50' }),
		enabled: !!entityId,
	})
}

export function useCreateComment(workspaceId: string, entityId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateCommentInput) => api.events.create(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(entityId) })
		},
	})
}
