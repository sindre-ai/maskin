import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

/** Saves a new text over a comment you wrote, then reloads the object's comments. */
export function useEditComment(workspaceId: string, entityId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ eventId, content }: { eventId: number; content: string }) =>
			api.events.update(workspaceId, eventId, content),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.events.byEntity(entityId) })
		},
		onError: (err) => {
			toast.error(err instanceof Error ? err.message : 'Could not save your edit')
		},
	})
}
