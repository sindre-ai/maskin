import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateWorkspaceSkillInput, UpdateWorkspaceSkillInput } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useWorkspaceSkills(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.workspaceSkills.all(workspaceId),
		queryFn: () => api.workspaceSkills.list(workspaceId),
		enabled: !!workspaceId,
	})
}

export function useWorkspaceSkill(workspaceId: string, name: string | null) {
	return useQuery({
		queryKey: queryKeys.workspaceSkills.detail(workspaceId, name ?? ''),
		// biome-ignore lint/style/noNonNullAssertion: guarded by enabled
		queryFn: () => api.workspaceSkills.get(workspaceId, name!),
		enabled: !!workspaceId && !!name,
	})
}

export function useCreateWorkspaceSkill(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateWorkspaceSkillInput) => api.workspaceSkills.create(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
		},
	})
}

export function useUpdateWorkspaceSkill(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			name,
			data,
		}: { name: string; data: UpdateWorkspaceSkillInput; newName?: string }) =>
			api.workspaceSkills.update(workspaceId, name, data),
		onSuccess: (_data, variables) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.workspaceSkills.detail(workspaceId, variables.name),
			})
			if (variables.newName && variables.newName !== variables.name) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.workspaceSkills.detail(workspaceId, variables.newName),
				})
			}
		},
	})
}

export function useDeleteWorkspaceSkill(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (name: string) => api.workspaceSkills.delete(workspaceId, name),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
		},
	})
}
