import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { trackWorkspaceSkillAttached } from '../lib/analytics'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useAgentSkillAttachments(actorId: string) {
	return useQuery({
		queryKey: queryKeys.agentSkillAttachments.all(actorId),
		queryFn: () => api.workspaceSkills.listForActor(actorId),
		enabled: !!actorId,
	})
}

export interface AttachSkillVariables {
	id: string
	workspaceId: string
	isValid: boolean
}

export function useAttachSkill(actorId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (skill: AttachSkillVariables) => api.workspaceSkills.attach(actorId, skill.id),
		onSuccess: (_data, skill) => {
			trackWorkspaceSkillAttached({
				workspace_id: skill.workspaceId,
				target_actor_id: actorId,
				skill_id: skill.id,
				skill_visible: skill.isValid,
			})
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
