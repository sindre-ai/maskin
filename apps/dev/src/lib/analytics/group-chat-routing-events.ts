import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export type GroupChatRoutingTrigger = 'new_message' | 'edit' | 'retry' | 'redo'

/** Why one candidate was woken or skipped (legacy path). `direct_1to1` is never emitted. */
export type GroupChatWakeReason =
	| 'tagged'
	| 'forced_retry'
	| 'direct_1to1'
	| 'model_yes'
	| 'default_yes_no_credentials'
	| 'default_yes_check_error'
	| 'model_no'
	| 'model_no_decision'
	| 'dropped_agent_cap'

/** How a wake reached the agent. `start_failed` means nothing was delivered. */
export type GroupChatDelivery =
	| 'wrote_to_running_session'
	| 'buffered_for_booting_session'
	| 'started_new_session'
	| 'joined_race_winner'
	| 'start_failed'
	| 'none'

export interface AgentRoutingOutcome {
	agentId: string
	decision: 'wake' | 'skip'
	reason: GroupChatWakeReason
	delivery: GroupChatDelivery
}

export interface GroupChatMessageRoutedProps {
	workspaceId: string
	conversationId: string
	messageId: number
	trigger: GroupChatRoutingTrigger
	authorActorId: string
	authorType: 'human' | 'agent'
	participantCount: number
	agentParticipantCount: number
	candidateCount: number
	taggedActorIds: string[]
	taggedAgentIds: string[]
	taggedHumanCount: number
	previousOtherActorId: string
	outcomes: AgentRoutingOutcome[]
	capHit: boolean
}

/**
 * One event per group-chat message, after every candidate settled (also on the cap path
 * and when nobody was woken). Ids and counts only, never message text. Per-agent detail
 * is one `agentId|decision|reason|delivery` string per candidate. Distinct id is the
 * author. Best-effort: never throws or rejects, so callers fire it without awaiting.
 */
export async function trackGroupChatMessageRouted(p: GroupChatMessageRoutedProps): Promise<void> {
	try {
		const woken = p.outcomes.filter((o) => o.decision === 'wake')
		const skipped = p.outcomes.filter((o) => o.decision === 'skip')
		await capturePosthogEvent('group_chat_message_routed', p.authorActorId, {
			workspace_id: p.workspaceId,
			conversation_id: p.conversationId,
			message_id: p.messageId,
			trigger: p.trigger,
			flag_on: false,
			rule: 'legacy',
			author_actor_id: p.authorActorId,
			author_type: p.authorType,
			participant_count: p.participantCount,
			agent_participant_count: p.agentParticipantCount,
			candidate_count: p.candidateCount,
			tagged_actor_ids: p.taggedActorIds,
			tagged_agent_ids: p.taggedAgentIds,
			tagged_human_count: p.taggedHumanCount,
			previous_other_actor_id: p.previousOtherActorId,
			woken_agent_ids: woken.map((o) => o.agentId),
			skipped_agent_ids: skipped.map((o) => o.agentId),
			agent_outcomes: p.outcomes.map((o) => `${o.agentId}|${o.decision}|${o.reason}|${o.delivery}`),
			defaulted_open_count: woken.filter((o) => o.reason.startsWith('default_yes')).length,
			cap_hit: p.capHit,
		})
	} catch (err) {
		logger.warn('Failed to emit group_chat_message_routed', {
			conversationId: p.conversationId,
			messageId: p.messageId,
			error: String(err),
		})
	}
}
