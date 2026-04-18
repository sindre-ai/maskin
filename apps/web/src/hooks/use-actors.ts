import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { type CreateActorInput, type UpdateActorInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useActors(workspaceId?: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.actors.all(workspaceId),
		queryFn: () => api.actors.list(workspaceId),
		enabled: options?.enabled,
	})
}

export function useActor(id: string) {
	return useQuery({
		queryKey: queryKeys.actors.detail(id),
		queryFn: () => api.actors.get(id),
		enabled: !!id,
	})
}

/** Derives agent from the workspace actors list — returns undefined for non-existent IDs (create mode). */
export function useAgent(id: string, workspaceId: string) {
	const { data: actors, ...rest } = useActors(workspaceId)
	return {
		...rest,
		data: actors?.find((a) => a.id === id),
	}
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

export function useDeleteActor(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.actors.delete(id, workspaceId),
		onSuccess: () => {
			toast.success('Agent deleted')
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
		onError: () => {
			toast.error('Failed to delete agent')
		},
	})
}

export function useResetActor(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.actors.reset(id, workspaceId),
		onSuccess: (_result, id) => {
			toast.success('Agent reset to default')
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
		},
		onError: () => {
			toast.error('Failed to reset agent')
		},
	})
}
