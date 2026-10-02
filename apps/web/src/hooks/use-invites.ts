import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type CreateInviteInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

// The invite dialog and pending rows render their own errors (409, 429, seat cap
// inline; resend/revoke failures in place), so the global error toast stays quiet.
const OWNS_ERRORS = { handlesOwnErrors: true }

export function useWorkspaceInvites(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.invites.list(workspaceId),
		queryFn: () => api.invites.list(workspaceId),
	})
}

export function useCreateInvite(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: OWNS_ERRORS,
		mutationFn: (data: Omit<CreateInviteInput, 'workspaceId'>) =>
			api.invites.create({ ...data, workspaceId }),
		onSuccess: (result) => {
			// A linked actor is a member immediately; a pending invite shows up in
			// the pending list. Refresh whichever list the outcome changed.
			queryClient.invalidateQueries({
				queryKey:
					result.status === 'linked'
						? queryKeys.workspaces.members(workspaceId)
						: queryKeys.invites.list(workspaceId),
			})
		},
	})
}

export function useResendInvite(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: OWNS_ERRORS,
		mutationFn: (inviteId: string) => api.invites.resend(inviteId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.invites.list(workspaceId) })
		},
	})
}

export function useRevokeInvite(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		meta: OWNS_ERRORS,
		mutationFn: (inviteId: string) => api.invites.revoke(inviteId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.invites.list(workspaceId) })
		},
	})
}
