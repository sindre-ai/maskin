import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			slackConversations: vi.fn(),
			slackUsers: vi.fn(),
		},
	},
}))

import {
	EMPTY_SLACK_FILTER_STATE,
	type SlackFilterState,
	SlackFilters,
	isSlackEntityType,
	slackFiltersFromConditions,
	slackFiltersToConditions,
} from '@/components/triggers/slack-filters'
import { api } from '@/lib/api'
import { TestWrapper } from '../../setup'

describe('isSlackEntityType', () => {
	it('returns true for slack.* entity types', () => {
		expect(isSlackEntityType('slack.channel_message')).toBe(true)
		expect(isSlackEntityType('slack.reaction')).toBe(true)
	})

	it('returns false for non-slack entity types', () => {
		expect(isSlackEntityType('insight')).toBe(false)
		expect(isSlackEntityType(undefined)).toBe(false)
		expect(isSlackEntityType(null)).toBe(false)
	})
})

describe('slackFiltersToConditions', () => {
	it('produces no conditions when state is empty', () => {
		expect(slackFiltersToConditions('slack.channel_message', EMPTY_SLACK_FILTER_STATE)).toEqual([])
	})

	it('emits include + exclude conditions for channels and users', () => {
		const state: SlackFilterState = {
			channelsInclude: ['C1', 'C2'],
			channelsExclude: ['C3'],
			usersInclude: ['U1'],
			usersExclude: ['U2'],
			reactionsInclude: [],
			reactionsExclude: [],
		}
		const out = slackFiltersToConditions('slack.channel_message', state)
		expect(out).toEqual([
			{ field: 'event.channel', operator: 'in', value: ['C1', 'C2'] },
			{ field: 'event.channel', operator: 'not_in', value: ['C3'] },
			{ field: 'event.user', operator: 'in', value: ['U1'] },
			{ field: 'event.user', operator: 'not_in', value: ['U2'] },
		])
	})

	it('uses event.item.channel for reactions', () => {
		const state: SlackFilterState = {
			...EMPTY_SLACK_FILTER_STATE,
			channelsInclude: ['C1'],
			reactionsInclude: ['thumbsup'],
		}
		const out = slackFiltersToConditions('slack.reaction', state)
		expect(out).toContainEqual({ field: 'event.item.channel', operator: 'in', value: ['C1'] })
		expect(out).toContainEqual({ field: 'event.reaction', operator: 'in', value: ['thumbsup'] })
	})

	it('omits reaction conditions for non-reaction events', () => {
		const state: SlackFilterState = {
			...EMPTY_SLACK_FILTER_STATE,
			reactionsInclude: ['thumbsup'],
		}
		const out = slackFiltersToConditions('slack.channel_message', state)
		expect(out.find((c) => c.field === 'event.reaction')).toBeUndefined()
	})
})

describe('slackFiltersFromConditions', () => {
	it('round-trips for channel message filters', () => {
		const conditions = [
			{ field: 'event.channel', operator: 'in', value: ['C1', 'C2'] },
			{ field: 'event.channel', operator: 'not_in', value: ['C3'] },
			{ field: 'event.user', operator: 'in', value: ['U1'] },
		]
		const state = slackFiltersFromConditions('slack.channel_message', conditions)
		expect(state.channelsInclude).toEqual(['C1', 'C2'])
		expect(state.channelsExclude).toEqual(['C3'])
		expect(state.usersInclude).toEqual(['U1'])
		expect(state.usersExclude).toEqual([])
	})

	it('returns empty state when no conditions provided', () => {
		expect(slackFiltersFromConditions('slack.channel_message', undefined)).toEqual(
			EMPTY_SLACK_FILTER_STATE,
		)
	})

	it('round-trips reaction filters using event.item.channel', () => {
		const conditions = [
			{ field: 'event.item.channel', operator: 'in', value: ['C1'] },
			{ field: 'event.reaction', operator: 'in', value: ['thumbsup', 'heart'] },
		]
		const state = slackFiltersFromConditions('slack.reaction', conditions)
		expect(state.channelsInclude).toEqual(['C1'])
		expect(state.reactionsInclude).toEqual(['thumbsup', 'heart'])
	})
})

describe('SlackFilters (rendering)', () => {
	beforeEach(() => {
		vi.mocked(api.integrations.slackConversations).mockResolvedValue([
			{
				id: 'C1',
				name: 'general',
				is_private: false,
				is_im: false,
				is_mpim: false,
				is_channel: true,
			},
		])
		vi.mocked(api.integrations.slackUsers).mockResolvedValue([
			{ id: 'U1', name: 'alice', real_name: 'Alice', is_bot: false },
		])
	})

	it('renders reaction filters only for slack.reaction', () => {
		const { rerender } = render(
			<TestWrapper>
				<SlackFilters
					entityType="slack.channel_message"
					integrationId="int-1"
					workspaceId="ws-1"
					value={EMPTY_SLACK_FILTER_STATE}
					onChange={() => {}}
				/>
			</TestWrapper>,
		)
		expect(screen.queryByText(/reactions/i)).toBeNull()

		rerender(
			<TestWrapper>
				<SlackFilters
					entityType="slack.reaction"
					integrationId="int-1"
					workspaceId="ws-1"
					value={EMPTY_SLACK_FILTER_STATE}
					onChange={() => {}}
				/>
			</TestWrapper>,
		)
		expect(screen.getByText(/Only fire for these reactions/i)).toBeInTheDocument()
	})

	it('shows a hint when no Slack integration is connected', () => {
		render(
			<TestWrapper>
				<SlackFilters
					entityType="slack.channel_message"
					integrationId={undefined}
					workspaceId="ws-1"
					value={EMPTY_SLACK_FILTER_STATE}
					onChange={() => {}}
				/>
			</TestWrapper>,
		)
		expect(screen.getByText(/Connect Slack/i)).toBeInTheDocument()
	})
})
