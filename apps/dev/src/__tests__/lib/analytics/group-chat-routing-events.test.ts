import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	type GroupChatMessageRoutedProps,
	trackGroupChatMessageRouted,
} from '../../../lib/analytics/group-chat-routing-events'

const base: GroupChatMessageRoutedProps = {
	workspaceId: 'ws-1',
	conversationId: 'conv-1',
	messageId: 42,
	trigger: 'new_message',
	flagOn: false,
	rule: 'legacy',
	authorActorId: 'human-1',
	authorType: 'human',
	participantCount: 4,
	agentParticipantCount: 2,
	candidateCount: 3,
	taggedActorIds: ['agent-a'],
	taggedAgentIds: ['agent-a'],
	taggedHumanCount: 0,
	previousOtherActorId: 'agent-b',
	outcomes: [
		{ agentId: 'a', decision: 'wake', reason: 'tagged', delivery: 'wrote_to_running_session' },
		{ agentId: 'b', decision: 'wake', reason: 'default_yes_check_error', delivery: 'start_failed' },
		{ agentId: 'c', decision: 'skip', reason: 'model_no', delivery: 'none' },
	],
	capHit: false,
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackGroupChatMessageRouted', () => {
	it('emits once, keyed by the author, with the contracted flat props', async () => {
		await trackGroupChatMessageRouted(base)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		const [event, distinctId, props] = capturePosthogEventMock.mock.calls[0] ?? []
		expect([event, distinctId]).toEqual(['group_chat_message_routed', 'human-1'])
		expect(props).toMatchObject({
			message_id: 42,
			trigger: 'new_message',
			flag_on: false,
			rule: 'legacy',
			participant_count: 4,
			candidate_count: 3,
			tagged_agent_ids: ['agent-a'],
			previous_other_actor_id: 'agent-b',
			woken_agent_ids: ['a', 'b'],
			skipped_agent_ids: ['c'],
			agent_outcomes: [
				'a|wake|tagged|wrote_to_running_session',
				'b|wake|default_yes_check_error|start_failed',
				'c|skip|model_no|none',
			],
			defaulted_open_count: 1,
			cap_hit: false,
		})
	})

	it('carries the flag state and the rule that decided when the wake rule is on', async () => {
		await trackGroupChatMessageRouted({
			...base,
			flagOn: true,
			rule: 'tagged',
			outcomes: [
				{ agentId: 'a', decision: 'wake', reason: 'rule_tagged', delivery: 'started_new_session' },
				{ agentId: 'b', decision: 'skip', reason: 'skip_not_addressed', delivery: 'none' },
			],
		})

		const props = capturePosthogEventMock.mock.calls[0]?.[2]
		expect(props).toMatchObject({
			flag_on: true,
			rule: 'tagged',
			woken_agent_ids: ['a'],
			skipped_agent_ids: ['b'],
			agent_outcomes: [
				'a|wake|rule_tagged|started_new_session',
				'b|skip|skip_not_addressed|none',
			],
			defaulted_open_count: 0,
		})
	})

	it('never rejects when the capture throws', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('posthog down'))

		await expect(trackGroupChatMessageRouted(base)).resolves.toBeUndefined()
	})
})
