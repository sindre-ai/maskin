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
	threadRootId: 40,
	trigger: 'new_message',
	flagOn: true,
	rule: 'tagged',
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
		{ agentId: 'a', decision: 'wake', reason: 'rule_tagged', delivery: 'wrote_to_running_session' },
		{ agentId: 'b', decision: 'wake', reason: 'rule_tagged', delivery: 'start_failed' },
		{ agentId: 'c', decision: 'skip', reason: 'skip_not_addressed', delivery: 'none' },
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
			thread_root_id: 40,
			trigger: 'new_message',
			flag_on: true,
			rule: 'tagged',
			participant_count: 4,
			candidate_count: 3,
			tagged_agent_ids: ['agent-a'],
			previous_other_actor_id: 'agent-b',
			woken_agent_ids: ['a', 'b'],
			skipped_agent_ids: ['c'],
			agent_outcomes: [
				'a|wake|rule_tagged|wrote_to_running_session',
				'b|wake|rule_tagged|start_failed',
				'c|skip|skip_not_addressed|none',
			],
			cap_hit: false,
		})
	})

	it('never rejects when the capture throws', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('posthog down'))

		await expect(trackGroupChatMessageRouted(base)).resolves.toBeUndefined()
	})
})
