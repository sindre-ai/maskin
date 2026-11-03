// Who a group-chat message wakes, as one pure function. The responder calls it for chats with
// 3 or more active participants, in place of a model "should I reply?" check. No database, no
// model call, no side effects: every input is passed in, so the same table drives the server and
// the tests.

export type WakeRuleName =
	| 'agent_cap'
	| 'retry_target'
	| 'tagged'
	| 'human_tag_only'
	| 'last_speaker'
	| 'first_message_lone_agent'
	| 'agent_untagged'
	| 'no_target'

export type WakeRuleWakeReason =
	| 'rule_tagged'
	| 'rule_retry_target'
	| 'rule_last_speaker'
	| 'rule_first_message_lone_agent'

export type WakeRuleSkipReason =
	| 'skip_not_addressed'
	| 'skip_human_tag_only'
	| 'skip_agent_untagged'
	| 'skip_last_writer_person'
	| 'skip_last_writer_gone'
	| 'skip_no_target'
	| 'dropped_agent_cap'

export type WakeRuleActorType = 'human' | 'agent'

export interface DecideWakesInput {
	author: { id: string; type: WakeRuleActorType }
	/** metadata.mentions as stored on the message. */
	mentions: readonly string[]
	/** Active participants only (left_at null), the author included. */
	participants: ReadonlyArray<{ id: string; type: WakeRuleActorType }>
	/**
	 * Latest real message with an id below this one, written by someone other than the sender.
	 * Auto-posted end-of-turn replies count as that agent speaking. Null when there is none.
	 */
	previousOther: { authorId: string; authorType: WakeRuleActorType } | null
	/** True when the chat has no earlier real message. */
	isFirstMessage: boolean
	/** Agent-authored messages in a row at the end of the chat, this one included. */
	consecutiveAgentTail: number
	maxConsecutiveAgents: number
	/** Set by "Redo this response". Retry with no agent chosen leaves it undefined. */
	retryTargetId?: string
}

export interface DecideWakesResult {
	rule: WakeRuleName
	wakes: Array<{ agentId: string; reason: WakeRuleWakeReason }>
	skips: Array<{ agentId: string; reason: WakeRuleSkipReason }>
}

export function decideWakes(input: DecideWakesInput): DecideWakesResult {
	const { author, participants, previousOther } = input
	const agentIds = unique(
		participants.filter((p) => p.type === 'agent' && p.id !== author.id).map((p) => p.id),
	)
	const agentSet = new Set(agentIds)

	const result = (
		rule: WakeRuleName,
		woken: ReadonlyArray<{ agentId: string; reason: WakeRuleWakeReason }>,
		skipReason: WakeRuleSkipReason,
	): DecideWakesResult => {
		const wokenIds = new Set(woken.map((w) => w.agentId))
		return {
			rule,
			wakes: [...woken],
			skips: agentIds
				.filter((id) => !wokenIds.has(id))
				.map((agentId) => ({ agentId, reason: skipReason })),
		}
	}

	// 1. Five agent messages in a row: nobody.
	if (input.consecutiveAgentTail >= input.maxConsecutiveAgents) {
		return result('agent_cap', [], 'dropped_agent_cap')
	}

	// 2. Redo with an agent chosen: that agent. No agent chosen: fall through to the normal rule.
	if (input.retryTargetId !== undefined) {
		const woken = agentSet.has(input.retryTargetId)
			? [{ agentId: input.retryTargetId, reason: 'rule_retry_target' as const }]
			: []
		return result('retry_target', woken, 'skip_not_addressed')
	}

	// 3. Tagged agents, exactly those. People tagged next to them are ignored.
	const taggedAgentIds = unique(input.mentions.filter((id) => agentSet.has(id)))
	if (taggedAgentIds.length > 0) {
		return result(
			'tagged',
			taggedAgentIds.map((agentId) => ({ agentId, reason: 'rule_tagged' as const })),
			'skip_not_addressed',
		)
	}

	// 4. Tags that name only people (or ids that are not agents here): nobody.
	if (input.mentions.length > 0) {
		return result('human_tag_only', [], 'skip_human_tag_only')
	}

	// 6. No tags from an agent: nobody. A handoff needs a tag.
	if (author.type === 'agent') {
		return result('agent_untagged', [], 'skip_agent_untagged')
	}

	// 5. No tags from a person. First message to a chat with exactly one agent: that agent.
	if (input.isFirstMessage) {
		const [onlyAgent] = agentIds
		if (agentIds.length === 1 && onlyAgent !== undefined) {
			return result(
				'first_message_lone_agent',
				[{ agentId: onlyAgent, reason: 'rule_first_message_lone_agent' }],
				'skip_not_addressed',
			)
		}
		// 7. First message, 2 or more agents: nobody.
		return result('no_target', [], 'skip_no_target')
	}

	// 5. Otherwise the latest writer other than the sender, when it is an agent still in the chat.
	// 7. Nobody else has written yet: nobody.
	if (!previousOther) return result('no_target', [], 'skip_no_target')
	if (previousOther.authorType !== 'agent') {
		return result('last_speaker', [], 'skip_last_writer_person')
	}
	if (!agentSet.has(previousOther.authorId)) {
		return result('last_speaker', [], 'skip_last_writer_gone')
	}
	return result(
		'last_speaker',
		[{ agentId: previousOther.authorId, reason: 'rule_last_speaker' }],
		'skip_not_addressed',
	)
}

function unique<T>(items: readonly T[]): T[] {
	return [...new Set(items)]
}
