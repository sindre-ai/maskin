import { useActors } from '@/hooks/use-actors'
import { useConversation } from '@/hooks/use-conversation'
import { getStoredActor } from '@/lib/auth'

export type DirectAgentState = 'not_in_workspace' | 'paused'

export interface DirectAgentStatus {
	id: string
	name: string
	state: DirectAgentState | null
}

/**
 * Status of the agent in a 1-1 chat (exactly two participants: the signed-in
 * human and one agent). Returns null for any other conversation shape.
 *
 * `not_in_workspace` is only reported once the workspace actors query has
 * succeeded and the agent is absent from it. While the query is loading or
 * after it failed the state stays null, so a slow or broken request never
 * shows the "can't reply" banner. `GET /api/actors` with the workspace header
 * returns every member with its `agentState`, so a missing id is reliable.
 */
export function useDirectAgentStatus(
	conversationId: string,
	workspaceId: string,
	options?: { enabled?: boolean },
): DirectAgentStatus | null {
	const enabled = options?.enabled ?? true
	const { data: conversation } = useConversation(conversationId, workspaceId, { enabled })
	const actors = useActors(workspaceId, { enabled })
	const self = getStoredActor()

	if (!enabled || !conversation || !self) return null
	const { participants } = conversation
	if (participants.length !== 2) return null
	const me = participants.find((p) => p.actorId === self.id && p.actorType === 'human')
	const agent = participants.find((p) => p.actorId !== self.id && p.actorType === 'agent')
	if (!me || !agent) return null

	if (!actors.isSuccess) return { id: agent.actorId, name: agent.actorName, state: null }
	const member = actors.data.find((a) => a.id === agent.actorId)
	if (!member) return { id: agent.actorId, name: agent.actorName, state: 'not_in_workspace' }
	return {
		id: agent.actorId,
		name: agent.actorName,
		state: member.agentState === 'paused' ? 'paused' : null,
	}
}
