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
import type { UnreadItem } from '@/lib/api'
import { TestWrapper } from '../../setup'

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
			title: 'Merge the trigger settings rewrite?',
			content: 'A page people use every day was rewritten, and no human has opened it.',
			status: 'in_review',
			metadata: { decision_type: 'architecture' },
			driver: 'agent-1',
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		},
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
		expect(screen.getByText('5H')).toBeInTheDocument()
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
	it('renders the object link, the why, the options and the composer', () => {
		renderCard()

		// The headline already names the object, so the meta line's link is a bare
		// "Open" — it only spells out a name when the card sits under a parent.
		expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
		expect(
			screen.getByText('A page people use every day was rewritten, and no human has opened it.'),
		).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send back' })).toBeInTheDocument()
		// The composer renders stacked with its default placeholder until the
		// Object detail split lands `variant`/`placeholder` on the v2 composer —
		// see the TODO in feed-card.tsx. Assert it is wired to the object, not
		// the addressed-to copy this card cannot yet pass through.
		expect(screen.getByTestId('comment-input')).toHaveAttribute('data-object-id', 'task-1')
	})

	it('offers no options on a plain thread', () => {
		renderCard({
			item: buildItem({
				object: {
					...buildItem().object,
					status: 'in_progress',
					metadata: {},
				} as UnreadItem['object'],
			}),
		})
		expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
		expect(screen.getByTestId('comment-input')).toBeInTheDocument()
	})

	it('hands the taken option up to the feed', async () => {
		const onDecide = vi.fn()
		const user = userEvent.setup()
		renderCard({ onDecide })

		await user.click(screen.getByRole('button', { name: 'Approve' }))
		await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1))
		expect(onDecide.mock.calls[0]?.[0]).toMatchObject({ id: 'approve', label: 'Approve' })
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
		renderCard({ decided: { id: 'approve', label: 'Approve' } })

		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toHaveTextContent('Approve')
		expect(receipt).toHaveTextContent('Sent to Code Reviewer')
		expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
		// The card's own controls are gone once it has been answered.
		expect(screen.queryByRole('button', { name: 'Send back' })).not.toBeInTheDocument()
	})
})
