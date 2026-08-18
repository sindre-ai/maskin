import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type UpdateWorkspaceInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useWorkspaces() {
	return useQuery({
		queryKey: queryKeys.workspaces.all(),
		queryFn: () => api.workspaces.list(),
	})
}

export function useUpdateWorkspace(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: UpdateWorkspaceInput) => api.workspaces.update(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all() })
		},
	})
}

export function useWorkspaceMembers(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.workspaces.members(workspaceId),
		queryFn: () => api.workspaces.members.list(workspaceId),
	})
}

export function useAddWorkspaceMember(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: { actor_id: string; role?: string }) =>
			api.workspaces.members.add(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.members(workspaceId) })
		},
	})
}

export function useUpdateWorkspaceMemberRole(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ actorId, role }: { actorId: string; role: string }) =>
			api.workspaces.members.updateRole(workspaceId, actorId, role),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.members(workspaceId) })
		},
	})
}

export function useRemoveWorkspaceMember(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (actorId: string) => api.workspaces.members.remove(workspaceId, actorId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.members(workspaceId) })
		},
	})
}
