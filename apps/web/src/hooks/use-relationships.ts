import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { trackEvent, trackRelationshipCreated } from '../lib/analytics'
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

			trackRelationshipCreated({
				entity_id: created.id,
				entity_type: 'relationship',
				relationship_type: created.type,
			})
			// `attached` edges from any object → file are the file-attach v1 event.
			// Trigger fires from the object-files panel and any future direct-attach
			// flow; the comment-attachment path emits this from the queue directly.
			// `type === 'attached'` is the semantic file-attach relationship type;
			// we deliberately do NOT gate on `targetType === 'file'` because some
			// legacy writers stamp the endpoint label inconsistently, and a label
			// check would silently drop the analytics event.
			if (created.type === 'attached') {
				trackEvent('object_attached_file', {
					entity_id: created.sourceId,
					entity_type: created.sourceType,
					source: 'web',
					flow_id: created.id,
					file_id: created.targetId,
					parent_entity_type: created.sourceType,
				})
			}
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
