import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useAgentSkillAttachments(actorId: string) {
	return useQuery({
		queryKey: queryKeys.agentSkillAttachments.all(actorId),
		queryFn: () => api.workspaceSkills.listForActor(actorId),
		enabled: !!actorId,
	})
}

export function useAttachSkill(actorId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (workspaceSkillId: string) => api.workspaceSkills.attach(actorId, workspaceSkillId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agentSkillAttachments.all(actorId) })
		},
	})
}

export function useDetachSkill(actorId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (workspaceSkillId: string) => api.workspaceSkills.detach(actorId, workspaceSkillId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.agentSkillAttachments.all(actorId) })
		},
	})
}
