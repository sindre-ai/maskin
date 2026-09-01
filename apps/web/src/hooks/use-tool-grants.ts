import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

export function useToolGrants(workspaceId: string, actorId?: string) {
	return useQuery({
		queryKey: actorId
			? queryKeys.toolGrants.forActor(workspaceId, actorId)
			: queryKeys.toolGrants.all(workspaceId),
		queryFn: () => api.toolGrants.list(workspaceId, actorId),
		enabled: !!workspaceId,
	})
}

export function useUpsertToolGrant(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (input: {
			actorId?: string | null
			integrationRef: string
			mode: 'all' | 'read' | 'custom'
			tools?: string[]
		}) => api.toolGrants.upsert(workspaceId, input),
		onSuccess: () => {
			// Invalidate the whole prefix: the first grant in a workspace seeds rows
			// for every other agent, so one write can change several agents' answers.
			queryClient.invalidateQueries({ queryKey: queryKeys.toolGrants.all(workspaceId) })
		},
		onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save'),
	})
}

export function useRevokeToolGrant(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.toolGrants.revoke(workspaceId, id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.toolGrants.all(workspaceId) })
		},
		onError: () => toast.error('Could not remove access'),
	})
}
