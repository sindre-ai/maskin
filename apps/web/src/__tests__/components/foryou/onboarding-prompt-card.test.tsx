import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { EventResponse, UnreadItem } from '@/lib/api'
import { buildEventResponse, buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUseEntityEvents = vi.fn()
const mockMarkReadMutate = vi.fn()

vi.mock('@/components/activity/comment-input', () => ({
	CommentInput: (props: { parentEventId?: number; objectId: string }) => (
		<div data-testid="comment-input" data-parent-event-id={props.parentEventId ?? ''} />
	),
}))

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: (...args: unknown[]) => mockUseEntityEvents(...args),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useMarkRead: () => ({ mutate: mockMarkReadMutate, isPending: false }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'human-1', name: 'Human', type: 'human', email: null }),
}))

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'session-1',
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({
			id: 'session-1',
			title: 'Getting your workspace ready',
			type: 'onboarding_session',
		}),
		...overrides,
	}
}

function buildPrompt(overrides: Partial<EventResponse> = {}) {
	return buildEventResponse({
		action: 'commented',
		entityType: 'object',
		entityId: 'session-1',
		actorId: 'agent-1',
		data: { content: 'What does your product do and who is it for?' },
		...overrides,
	})
}

import { OnboardingPromptCard } from '@/components/foryou/onboarding-prompt-card'

describe('OnboardingPromptCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows the session title as the header', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(<OnboardingPromptCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Getting your workspace ready')).toBeInTheDocument()
	})

	it('shows loading text when events are not yet available', () => {
		mockUseEntityEvents.mockReturnValue({ data: undefined })
		render(<OnboardingPromptCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Loading…')).toBeInTheDocument()
	})

	it('shows the latest agent prompt in large text', () => {
		// events from API come back desc (newest first)
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildPrompt({ id: 20, data: { content: 'Who is your ideal customer?' } }),
				buildPrompt({ id: 10, data: { content: 'What does your product do?' } }),
			],
		})
		render(<OnboardingPromptCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Who is your ideal customer?')).toBeInTheDocument()
	})

	it('ignores comments from the current human user when finding the prompt', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildPrompt({ id: 30, actorId: 'human-1', data: { content: 'My reply' } }),
				buildPrompt({ id: 20, data: { content: 'What is your ICP?' } }),
			],
		})
		render(<OnboardingPromptCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('What is your ICP?')).toBeInTheDocument()
		expect(screen.queryByText('My reply')).not.toBeInTheDocument()
	})

	it('renders CommentInput with the prompt event id as parentEventId', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildPrompt({ id: 42, data: { content: 'What is your North Star metric?' } })],
		})
		render(<OnboardingPromptCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		const input = screen.getByTestId('comment-input')
		expect(input).toHaveAttribute('data-parent-event-id', '42')
	})
})
