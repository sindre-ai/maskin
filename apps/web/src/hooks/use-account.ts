import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { clearAuth } from '../lib/auth'
import { queryKeys } from '../lib/query-keys'

export function useAccountDeletionPreview(enabled: boolean, deleteSoleWorkspaces = false) {
	return useQuery({
		queryKey: queryKeys.account.deletionPreview(deleteSoleWorkspaces),
		queryFn: () => api.account.deletionPreview(deleteSoleWorkspaces),
		enabled,
		// Toggling the flag refetches; keep the dialog (and its checkbox) mounted meanwhile.
		placeholderData: keepPreviousData,
		// A stale "can delete" answer is worse than a refetch: ownership or billing may have changed.
		gcTime: 0,
	})
}

export function useDeleteAccount() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: { password: string; delete_sole_workspaces?: boolean }) =>
			api.account.delete(data),
		onSuccess: () => {
			// The actor and its API key are gone: nothing cached or stored is valid any more.
			clearAuth()
			queryClient.clear()
		},
	})
}
