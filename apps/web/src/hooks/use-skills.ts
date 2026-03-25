import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SaveSkillInput } from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useSkills(actorId: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.skills.all(actorId),
		queryFn: () => api.skills.list(actorId, workspaceId),
		enabled: !!actorId && !!workspaceId,
	})
}

export function useSkill(actorId: string, skillName: string | null, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.skills.detail(actorId, skillName ?? ''),
		// biome-ignore lint/style/noNonNullAssertion: guarded by enabled
		queryFn: () => api.skills.get(actorId, skillName!, workspaceId),
		enabled: !!actorId && !!skillName && !!workspaceId,
	})
}

export function useSaveSkill(actorId: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ skillName, data }: { skillName: string; data: SaveSkillInput }) =>
			api.skills.save(actorId, skillName, data, workspaceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.skills.all(actorId) })
		},
	})
}

export function useDeleteSkill(actorId: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (skillName: string) => api.skills.delete(actorId, skillName, workspaceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.skills.all(actorId) })
		},
	})
}
