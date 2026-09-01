import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'agent-1', name: 'Code Reviewer', type: 'agent' }] }),
	useActor: () => ({ data: undefined }),
}))

const mockUseEntityEvents = vi.fn(() => ({ data: undefined }))
vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: (...args: unknown[]) => mockUseEntityEvents(...(args as [])),
}))

// The real composer pulls in uploads, drafts, the slash picker and dictation;
// the card only cares that it renders one, wired to the right object.
vi.mock('@/components/activity/comment-input', () => ({
	CommentInput: ({ objectId }: { objectId?: string }) => (
		<div data-testid="comment-input" data-object-id={objectId} />
	),
}))

import { FeedCard } from '@/components/foryou/feed-card'
import type { LatestMention, LatestMentionDecision, UnreadItem } from '@/lib/api'
import { TestWrapper } from '../../setup'

function buildDecision(overrides: Partial<LatestMentionDecision> = {}): LatestMentionDecision {
	return {
		title: 'Merge the trigger settings rewrite?',
		summary:
			'A page 200 people use every day was rewritten, and no human has opened it. I have run the suite and the visual diff.',
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
		truncated: false,
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
			content: 'A page people use every day was rewritten, and no human has opened it.',
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
		expanded: true,
		decided: null,
		onDecide: vi.fn(),
		replied: false,
		onReplied: vi.fn(),
		onMarkRead: vi.fn(),
		...overrides,
	}
	return { props, ...render(<FeedCard {...props} />, { wrapper: TestWrapper }) }
}

describe('FeedCard — row state', () => {
	it('shows the ask on one line with its status, driver and age', async () => {
		const onToggleExpanded = vi.fn()
		const user = userEvent.setup()
		renderCard({ expanded: false, onToggleExpanded })

		expect(screen.getByText('Merge the trigger settings rewrite?')).toBeInTheDocument()
		expect(screen.getByLabelText('Status in review')).toBeInTheDocument()
		expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
		// `RelativeTime` emits "5h"; the feed's uppercase is a CSS transform, so
		// the accessible text stays lowercase.
		const age = screen.getByText('5h')
		expect(age).toBeInTheDocument()
		expect(age.tagName).toBe('TIME')
		expect(age.className).toContain('tabular-nums')
		// The body only exists in the expanded state.
		expect(screen.queryByTestId('comment-input')).not.toBeInTheDocument()

		await user.click(screen.getByText('Merge the trigger settings rewrite?'))
		expect(onToggleExpanded).toHaveBeenCalledTimes(1)
	})

	it('reads as waiting on the agent once the reader has answered', () => {
		renderCard({ expanded: false, replied: true })
		expect(screen.getByText('Waiting on Code Reviewer')).toBeInTheDocument()
	})

	it('notes how long a card has been held', () => {
		renderCard({
			expanded: false,
			item: buildItem({
				latest_activity_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
			}),
		})
		expect(screen.getByText('held 3 days')).toBeInTheDocument()
	})
})

describe('FeedCard — full state', () => {
	it('leads with the agent ask and renders its options, not the object description', () => {
		renderCard()

		// The object's own name is context in the meta line now; the headline is
		// the decision the agent asked for.
		expect(screen.getByRole('link', { name: /Trigger settings rewrite/ })).toBeInTheDocument()
		expect(screen.getByText(/A page 200 people use every day was rewritten/)).toBeInTheDocument()
		expect(
			screen.getByText('This ships to every workspace at once, so I will not merge it alone.'),
		).toBeInTheDocument()
		// The object's description no longer appears on the card at all.
		expect(
			screen.queryByText('A page people use every day was rewritten, and no human has opened it.'),
		).not.toBeInTheDocument()
		// The buttons are the agent's own labels, each carrying its consequences.
		expect(screen.getByRole('button', { name: 'Merge now' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send back' })).toBeInTheDocument()
		expect(screen.getByText('No rollback once migrations run')).toBeInTheDocument()
		// The composer renders stacked with its default placeholder until the
		// Object detail split lands `variant`/`placeholder` on the v2 composer —
		// see the TODO in feed-card.tsx. Assert it is wired to the object, not
		// the addressed-to copy this card cannot yet pass through.
		expect(screen.getByTestId('comment-input')).toHaveAttribute('data-object-id', 'task-1')
	})

	// A review-status task used to be enough to invent Approve / Send back. Only
	// an agent-authored decision produces options now.
	it('offers no options on a mention with no decision, and renders the comment body', () => {
		renderCard({
			item: buildItem({
				latest_mention: buildMention({
					decision: null,
					content: 'Can you confirm the launch date?',
				}),
			}),
		})
		expect(screen.queryByRole('button', { name: 'Merge now' })).not.toBeInTheDocument()
		expect(screen.getByText('Can you confirm the launch date?')).toBeInTheDocument()
		expect(screen.getByTestId('comment-input')).toBeInTheDocument()
	})

	// An item whose events were pruned still has to render something.
	it('falls back to the object title when there is no mention payload', () => {
		renderCard({ item: buildItem({ latest_mention: undefined }) })
		expect(screen.getByText('Trigger settings rewrite')).toBeInTheDocument()
		// It is the headline, so the meta link does not repeat it.
		expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
		expect(screen.getByTestId('comment-input')).toBeInTheDocument()
	})

	it('hands the taken option up to the feed', async () => {
		const onDecide = vi.fn()
		const user = userEvent.setup()
		renderCard({ onDecide })

		await user.click(screen.getByRole('button', { name: 'Merge now' }))
		await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1))
		expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ id: 'merge_now', label: 'Merge now' })
	})

	// The option is acknowledged with a 260ms beat before `onDecide` fires, and
	// `onDecide` posts a real reply. A bulk dismiss unmounts the card inside that
	// window, so an uncancelled timer would comment on a thread the reader just
	// cleared.
	it('does not decide when the card unmounts during the acknowledgement beat', async () => {
		const onDecide = vi.fn()
		const user = userEvent.setup()
		const { unmount } = renderCard({ onDecide })

		await user.click(screen.getByRole('button', { name: 'Merge now' }))
		unmount()
		// Comfortably past the 260ms beat — the cancelled timer must never fire.
		await new Promise((resolve) => setTimeout(resolve, 500))

		expect(onDecide).not.toHaveBeenCalled()
	})

	it('loads the thread only once the timeline history is opened', async () => {
		const user = userEvent.setup()
		renderCard()

		expect(mockUseEntityEvents).toHaveBeenCalledWith('ws-1', 'task-1', { enabled: false })
		await user.click(screen.getByRole('button', { name: /Show timeline history/ }))
		await waitFor(() =>
			expect(mockUseEntityEvents).toHaveBeenLastCalledWith('ws-1', 'task-1', { enabled: true }),
		)
		expect(screen.getByText('On this object')).toBeInTheDocument()
	})
})

describe('FeedCard — decided state', () => {
	it('shows the receipt for the option that was taken, with nothing to take back', () => {
		renderCard({ decided: { id: 'merge_now', label: 'Merge now' } })

		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toHaveTextContent('Merge now')
		expect(receipt).toHaveTextContent('Sent to Code Reviewer')
		expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
		// The card's own controls are gone once it has been answered.
		expect(screen.queryByRole('button', { name: 'Send back' })).not.toBeInTheDocument()
	})
})
