import type { WakeRuleName, WakeRuleSkipReason, WakeRuleWakeReason } from '@maskin/shared'
import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export type GroupChatRoutingTrigger = 'new_message' | 'edit' | 'retry' | 'redo'

/**
 * Why one candidate was woken or skipped, from the wake rule. `skip_resolver_error` is its
 * fail-closed path.
 */
export type GroupChatWakeReason =
	| 'dropped_agent_cap'
	| WakeRuleWakeReason
	| WakeRuleSkipReason
	| 'skip_resolver_error'

/** The rule that decided. `resolver_error` is the fail-closed path. */
export type GroupChatRoutingRule = WakeRuleName | 'resolver_error'

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
	/** The thread the routed message sits in; null for a message in the main chat. */
	threadRootId: number | null
	trigger: GroupChatRoutingTrigger
	flagOn: boolean
	rule: GroupChatRoutingRule
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
			thread_root_id: p.threadRootId,
			trigger: p.trigger,
			flag_on: p.flagOn,
			rule: p.rule,
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
