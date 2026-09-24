import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
	type RelationshipCreatedSource,
	trackEvent,
	trackRelationshipCreated,
} from '../lib/analytics'
import { type CreateRelationshipInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useRelationships(workspaceId: string, params?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.relationships.all(workspaceId),
		queryFn: () => api.relationships.list(workspaceId, params),
	})
}

// Callers can tag the `source` of a create so PostHog can attribute uptake of
// the D11 dashed CTAs vs. the existing AddLinkForm / drag-drop paths — the
// property Analytics called out on comment 522050 of the parent bet.
export type CreateRelationshipVariables = CreateRelationshipInput & {
	source?: RelationshipCreatedSource
	/** Human-readable title of the endpoint being linked — passed through so
	 *  the success toast can read `Linked <name> to <object>` per Designer
	 *  §6, rather than a generic "Linked" message. */
	linkedTitle?: string
	/** Human-readable title of the anchor object (the source object the link
	 *  is being added on). Optional; when both are present the toast reads
	 *  `Linked <linkedTitle> to <anchorTitle>`. */
	anchorTitle?: string
}

export function useCreateRelationship(workspaceId: string, objectId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			source: _source,
			linkedTitle: _lt,
			anchorTitle: _at,
			...data
		}: CreateRelationshipVariables) => api.relationships.create(workspaceId, data),
		onSuccess: (created, variables) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(objectId) })
			const otherId = created.sourceId === objectId ? created.targetId : created.sourceId
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(otherId) })

			trackRelationshipCreated({
				entity_id: created.id,
				entity_type: 'relationship',
				relationship_type: created.type,
				source: variables.source,
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

			// Success toast: `Linked <name> to <object title>` with an Undo
			// action that deletes the freshly-created edge. Falls back to a
			// terser reading when the caller couldn't hand us titles (older
			// call sites don't set `linkedTitle`/`anchorTitle`).
			const linkedTitle = variables.linkedTitle ?? 'item'
			const anchorTitle = variables.anchorTitle
			const message = anchorTitle
				? `Linked ${linkedTitle} to ${anchorTitle}`
				: `Linked ${linkedTitle}`
			toast.success(message, {
				action: {
					label: 'Undo',
					onClick: async () => {
						try {
							await api.relationships.delete(created.id, workspaceId)
							queryClient.invalidateQueries({ queryKey: queryKeys.relationships.all(workspaceId) })
							queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(objectId) })
							queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(otherId) })
						} catch {
							// Undo is best-effort — a failed unlink surfaces in the
							// Related list on next refetch; a second toast here would
							// pile on the user without adding actionable info.
						}
					},
				},
			})
		},
		onError: () => {
			toast.error('Failed to link objects')
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
		onError: () => {
			toast.error('Failed to remove relationship')
		},
	})
}
