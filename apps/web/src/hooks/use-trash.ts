import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

/** Every trashed row in the workspace, newest first. */
export function useTrash(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.trash.list(workspaceId),
		queryFn: () => api.trash.list(workspaceId),
		enabled: !!workspaceId,
	})
}

/** Restore one trashed row and refresh the surfaces it can reappear in. */
export function useRestoreFromTrash(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.trash.restore(workspaceId, id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.trash.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.files.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.loops.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
		},
	})
}
