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

export function useObjectRelationships(workspaceId: string, objectId: string) {
	return useQuery({
		queryKey: queryKeys.relationships.byObject(objectId),
		queryFn: async () => {
			const [asSource, asTarget] = await Promise.all([
				api.relationships.list(workspaceId, { source_id: objectId }),
				api.relationships.list(workspaceId, { target_id: objectId }),
			])
			return { asSource, asTarget }
		},
		enabled: !!objectId,
	})
}

export function useCreateRelationship(workspaceId: string, objectId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateRelationshipInput) => api.relationships.create(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.byObject(objectId) })
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
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.byObject(objectId) })
		},
	})
}
