import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type UpdateWorkspaceInput, api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useWorkspaces() {
	return useQuery({
		queryKey: queryKeys.workspaces.all(),
		queryFn: () => api.workspaces.list(),
	})
}

export function useCreateWorkspace() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: { name: string }) => api.workspaces.create(data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all() })
		},
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

export function useWorkspaceDeletionPreview(workspaceId: string, enabled: boolean) {
	return useQuery({
		queryKey: queryKeys.workspaces.deletionPreview(workspaceId),
		queryFn: () => api.workspaces.deletionPreview(workspaceId),
		enabled,
		// A stale "can delete" answer is worse than a refetch: the plan or ownership may have changed.
		gcTime: 0,
	})
}

export function useDeleteWorkspace(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (confirmName: string) => api.workspaces.delete(workspaceId, confirmName),
		onSuccess: () => {
			// Drop everything cached for the workspace that no longer exists, then the list so the
			// index route re-resolves which workspace (or the picker) to land on.
			queryClient.removeQueries({ queryKey: queryKeys.workspaces.detail(workspaceId) })
			queryClient.removeQueries({ queryKey: queryKeys.workspaces.deletionPreview(workspaceId) })
			queryClient.removeQueries({ queryKey: queryKeys.workspaces.all(), exact: true })
		},
	})
}
