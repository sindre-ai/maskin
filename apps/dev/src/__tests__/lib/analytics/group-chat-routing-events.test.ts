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

function props(overrides: Partial<GroupChatMessageRoutedProps> = {}): GroupChatMessageRoutedProps {
	return {
		workspaceId: 'ws-1',
		conversationId: 'conv-1',
		messageId: 42,
		trigger: 'new_message',
		authorActorId: 'human-1',
		authorType: 'human',
		participantCount: 4,
		agentParticipantCount: 2,
		candidateCount: 2,
		taggedActorIds: ['agent-a'],
		taggedAgentIds: ['agent-a'],
		taggedHumanCount: 0,
		previousOtherActorId: 'agent-b',
		outcomes: [
			{
				agentId: 'agent-a',
				decision: 'wake',
				reason: 'tagged',
				delivery: 'wrote_to_running_session',
			},
			{ agentId: 'agent-b', decision: 'skip', reason: 'model_no', delivery: 'none' },
		],
		capHit: false,
		...overrides,
	}
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackGroupChatMessageRouted', () => {
	it('emits once with the author as distinct id and the contracted flat props', async () => {
		await trackGroupChatMessageRouted(props())

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('group_chat_message_routed', 'human-1', {
			workspace_id: 'ws-1',
			conversation_id: 'conv-1',
			message_id: 42,
			trigger: 'new_message',
			flag_on: false,
			rule: 'legacy',
			author_actor_id: 'human-1',
			author_type: 'human',
			participant_count: 4,
			agent_participant_count: 2,
			candidate_count: 2,
			tagged_actor_ids: ['agent-a'],
			tagged_agent_ids: ['agent-a'],
			tagged_human_count: 0,
			previous_other_actor_id: 'agent-b',
			woken_agent_ids: ['agent-a'],
			skipped_agent_ids: ['agent-b'],
			agent_outcomes: [
				'agent-a|wake|tagged|wrote_to_running_session',
				'agent-b|skip|model_no|none',
			],
			defaulted_open_count: 0,
			cap_hit: false,
		})
	})

	it('only uses string, number, boolean, null, string[] and number[] values', async () => {
		await trackGroupChatMessageRouted(props())

		const sent = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		for (const value of Object.values(sent)) {
			const flat =
				value === null ||
				['string', 'number', 'boolean'].includes(typeof value) ||
				(Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number'))
			expect(flat).toBe(true)
		}
	})

	it('counts woken agents whose reason is a default-yes', async () => {
		await trackGroupChatMessageRouted(
			props({
				outcomes: [
					{
						agentId: 'agent-a',
						decision: 'wake',
						reason: 'default_yes_no_credentials',
						delivery: 'started_new_session',
					},
					{
						agentId: 'agent-b',
						decision: 'wake',
						reason: 'default_yes_check_error',
						delivery: 'buffered_for_booting_session',
					},
					{
						agentId: 'agent-c',
						decision: 'wake',
						reason: 'model_yes',
						delivery: 'joined_race_winner',
					},
					{ agentId: 'agent-d', decision: 'skip', reason: 'model_no_decision', delivery: 'none' },
				],
			}),
		)

		const sent = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(sent.defaulted_open_count).toBe(2)
		expect(sent.woken_agent_ids).toEqual(['agent-a', 'agent-b', 'agent-c'])
		expect(sent.skipped_agent_ids).toEqual(['agent-d'])
	})

	it('reports a cap hit with every candidate dropped', async () => {
		await trackGroupChatMessageRouted(
			props({
				capHit: true,
				outcomes: [
					{ agentId: 'agent-a', decision: 'skip', reason: 'dropped_agent_cap', delivery: 'none' },
					{ agentId: 'agent-b', decision: 'skip', reason: 'dropped_agent_cap', delivery: 'none' },
				],
			}),
		)

		const sent = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(sent.cap_hit).toBe(true)
		expect(sent.woken_agent_ids).toEqual([])
		expect(sent.agent_outcomes).toEqual([
			'agent-a|skip|dropped_agent_cap|none',
			'agent-b|skip|dropped_agent_cap|none',
		])
	})

	it('never rejects when the capture throws', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('posthog down'))

		await expect(trackGroupChatMessageRouted(props())).resolves.toBeUndefined()
	})
})
