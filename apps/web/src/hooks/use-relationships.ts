import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { type CreateRelationshipInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useRelationships(workspaceId: string, params?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.relationships.all(workspaceId),
		queryFn: () => api.relationships.list(workspaceId, params),
	})
}

export function useCreateRelationship(workspaceId: string, objectId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateRelationshipInput) => api.relationships.create(workspaceId, data),
		onSuccess: (created) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(objectId) })
			const otherId = created.sourceId === objectId ? created.targetId : created.sourceId
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(otherId) })
		},
	})
}

export function useDeleteRelationship(workspaceId: string, objectId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.relationships.delete(id, workspaceId),
		onSuccess: () => {
			toast.success('Relationship removed')
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(objectId) })
		},
	})
}
