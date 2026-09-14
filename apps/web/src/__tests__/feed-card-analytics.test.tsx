import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('./mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'agent-1', name: 'Code Reviewer', type: 'agent' }] }),
	useActor: () => ({ data: undefined }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: () => ({ data: undefined }),
}))

// The real composer is not the SUT here; the card only cares one renders.
vi.mock('@/components/activity/comment-input', () => ({
	CommentInput: () => <div data-testid="comment-input" />,
}))

const trackForyouCardShown = vi.fn()
const trackForyouCardMarkedRead = vi.fn()
const trackForyouCardAction = vi.fn()
vi.mock('@/lib/analytics', () => ({
	trackForyouCardShown: (...args: unknown[]) => trackForyouCardShown(...args),
	trackForyouCardMarkedRead: (...args: unknown[]) => trackForyouCardMarkedRead(...args),
	trackForyouCardAction: (...args: unknown[]) => trackForyouCardAction(...args),
}))

import { FeedCard } from '@/components/foryou/feed-card'
import type { LatestMention, LatestMentionDecision, UnreadItem } from '@/lib/api'
import { __resetImpressionsForTesting } from '@/lib/foryou-impressions'
import { TestWrapper } from './setup'

function buildDecision(overrides: Partial<LatestMentionDecision> = {}): LatestMentionDecision {
	return {
		title: 'Merge the trigger settings rewrite?',
		summary: 'A page 200 people use every day was rewritten, and no human has opened it.',
		ask: 'This ships to every workspace at once, so I will not merge it alone.',
		options: [
			{
				label: 'Send back',
				consequences: ['Nothing ships this cycle', 'Costs another review round'],
			},
			{
				label: 'Merge now',
				recommended: true,
				consequences: ['Ships with tonight deploy', 'No rollback once migrations run'],
			},
		],
		...overrides,
	}
}

function buildMention(overrides: Partial<LatestMention> = {}): LatestMention {
	return {
		event_id: 42,
		actor_id: 'agent-1',
		created_at: new Date().toISOString(),
		content: 'Merge the trigger settings rewrite?',
		attention: 4,
		decision: buildDecision(),
		...overrides,
	}
}

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'task-1',
		unread_count: 2,
		mentioning_unread_count: 0,
		max_unread_attention: 4,
		latest_event_id: 42,
		latest_activity_at: new Date(Date.now() - 5 * 3_600_000).toISOString(),
		object: {
			id: 'task-1',
			workspaceId: 'ws-1',
			type: 'task',
			title: 'Trigger settings rewrite',
			content: 'A page people use every day was rewritten.',
			status: 'in_review',
			metadata: { decision_type: 'architecture' },
			driver: 'agent-1',
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		},
		latest_mention: buildMention(),
		...overrides,
	}
}

function renderCard(overrides: Partial<React.ComponentProps<typeof FeedCard>> = {}) {
	const props: React.ComponentProps<typeof FeedCard> = {
		workspaceId: 'ws-1',
		item: buildItem(),
		expanded: false,
		decided: null,
		onDecide: vi.fn(),
		replied: false,
		onReplied: vi.fn(),
		onMarkRead: vi.fn(),
		...overrides,
	}
	return { props, ...render(<FeedCard {...props} />, { wrapper: TestWrapper }) }
}

beforeEach(() => {
	trackForyouCardShown.mockClear()
	trackForyouCardMarkedRead.mockClear()
	trackForyouCardAction.mockClear()
	__resetImpressionsForTesting()
})

afterEach(() => {
	__resetImpressionsForTesting()
})

describe('FeedCard analytics wiring', () => {
	it('MarkReadButton click emits foryou_card_marked_read once with the card_kind + card_id', async () => {
		const user = userEvent.setup()
		const onMarkRead = vi.fn()
		renderCard({ onMarkRead })

		await user.click(screen.getByLabelText('Mark as read'))

		expect(trackForyouCardMarkedRead).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedRead).toHaveBeenCalledWith({
			card_kind: expect.any(String),
			card_id: 'task-1',
		})
		// Analytics fires before the mutation, so an API failure never loses
		// the intent signal.
		expect(onMarkRead).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedRead.mock.invocationCallOrder[0]).toBeLessThan(
			onMarkRead.mock.invocationCallOrder[0],
		)
	})

	it('remounting the same card_id emits foryou_card_shown exactly once — module-scoped dedup', () => {
		const item = buildItem()
		const props = {
			workspaceId: 'ws-1',
			item,
			expanded: true,
			decided: null,
			onDecide: vi.fn(),
			replied: false,
			onReplied: vi.fn(),
			onMarkRead: vi.fn(),
		} as const

		const first = render(<FeedCard {...props} />, { wrapper: TestWrapper })
		expect(trackForyouCardShown).toHaveBeenCalledTimes(1)
		first.unmount()

		// A second mount for the same card_id is exactly what happens when the
		// user navigates away from /$workspaceId/ and back — this used to re-fire
		// the impression, inflating volume 5-8x. Module-scoped dedup makes it a
		// no-op.
		render(<FeedCard {...props} />, { wrapper: TestWrapper })
		expect(trackForyouCardShown).toHaveBeenCalledTimes(1)
	})
})
