import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SaveSkillInput } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useWorkspaceSkills(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.workspaceSkills.all(workspaceId),
		queryFn: () => api.workspaceSkills.list(workspaceId),
		enabled: !!workspaceId,
	})
}

export function useWorkspaceSkill(workspaceId: string, skillName: string | null) {
	return useQuery({
		queryKey: queryKeys.workspaceSkills.detail(workspaceId, skillName ?? ''),
		// biome-ignore lint/style/noNonNullAssertion: guarded by enabled
		queryFn: () => api.workspaceSkills.get(workspaceId, skillName!),
		enabled: !!workspaceId && !!skillName,
	})
}

export function useSaveWorkspaceSkill(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ skillName, data }: { skillName: string; data: SaveSkillInput }) =>
			api.workspaceSkills.save(workspaceId, skillName, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
		},
	})
}

export function useDeleteWorkspaceSkill(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (skillName: string) => api.workspaceSkills.delete(workspaceId, skillName),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.workspaceSkills.all(workspaceId) })
		},
	})
}
