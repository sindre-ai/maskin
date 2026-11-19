import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

/** The workspace default and each agent's resulting send mode per draft kind. */
export function useSendPermissions(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sendPermissions.all(workspaceId),
		queryFn: () => api.sendPermissions.get(workspaceId),
	})
}

export function useSetSendPermission(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (body: Parameters<typeof api.sendPermissions.set>[1]) =>
			api.sendPermissions.set(workspaceId, body),
		onSuccess: () => {
			toast.success('Send permission updated')
			queryClient.invalidateQueries({ queryKey: queryKeys.sendPermissions.all(workspaceId) })
		},
	})
}
