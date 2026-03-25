import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CreateActorInput, type UpdateActorInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useActors(workspaceId?: string) {
	return useQuery({
		queryKey: queryKeys.actors.all(workspaceId),
		queryFn: () => api.actors.list(workspaceId),
	})
}

export function useActor(id: string) {
	return useQuery({
		queryKey: queryKeys.actors.detail(id),
		queryFn: () => api.actors.get(id),
		enabled: !!id,
	})
}

export function useCreateActor(workspaceId?: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateActorInput) => api.actors.create(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
	})
}

export function useUpdateActor(workspaceId?: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateActorInput }) =>
			api.actors.update(id, data),
		onSuccess: (_result, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
	})
}

export function useRegenerateApiKey() {
	return useMutation({
		mutationFn: (id: string) => api.actors.regenerateApiKey(id),
	})
}
