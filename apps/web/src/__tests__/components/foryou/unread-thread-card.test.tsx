import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { EventResponse, UnreadItem } from '@/lib/api'
import { buildEventResponse, buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUseEntityEvents = vi.fn()
const mockMarkReadMutate = vi.fn()
const mockUseMarkRead = vi.fn(() => ({ mutate: mockMarkReadMutate, isPending: false }))
const commentInputCalls: Array<{ parentEventId?: number; objectId: string }> = []

vi.mock('@/components/activity/comment-input', () => ({
	CommentInput: (props: { parentEventId?: number; objectId: string }) => {
		commentInputCalls.push({ parentEventId: props.parentEventId, objectId: props.objectId })
		return <div data-testid="comment-input" data-parent-event-id={props.parentEventId ?? ''} />
	},
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: (...args: unknown[]) => mockUseEntityEvents(...args),
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useMarkRead: () => mockUseMarkRead(),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'viewer', name: 'Viewer', type: 'human', email: null }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({
		data: { id: 'other', name: 'Other', type: 'human' },
	}),
	useActors: () => ({
		data: [
			{ id: 'viewer', name: 'Viewer', type: 'human', isSystem: false },
			{ id: 'other', name: 'Other', type: 'human', isSystem: false },
		],
	}),
}))

import { UnreadThreadCard } from '@/components/foryou/unread-thread-card'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentions_you: false,
		latest_event_id: 20,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({ id: 'obj-1', title: 'Onboarding A/B', type: 'bet' }),
		...overrides,
	}
}

function buildComment(overrides: Partial<EventResponse> = {}) {
	return buildEventResponse({
		action: 'commented',
		entityType: 'object',
		entityId: 'obj-1',
		data: { content: 'Hello' },
		...overrides,
	})
}

describe('UnreadThreadCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMarkReadMutate.mockReset()
		commentInputCalls.length = 0
	})

	it('renders the object title and unread count', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 3 })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Onboarding A/B')).toBeInTheDocument()
		expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
	})

	it('renders a "Mentioned" badge when the unread thread mentions the viewer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ mentions_you: true })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByLabelText('Mentioned')).toBeInTheDocument()
	})

	it('omits the "Mentioned" badge when mentions_you is false', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ mentions_you: false })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByLabelText('Mentioned')).not.toBeInTheDocument()
	})

	it('renders a "New" divider before the first thread containing unread activity', () => {
		// events from api come back desc; the most recent two are unread from
		// "other", the oldest is the viewer's own (read).
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 30, actorId: 'other', data: { content: 'newer' } }),
				buildComment({ id: 20, actorId: 'other', data: { content: 'middle' } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'oldest' } }),
			],
		})
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 2 })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByLabelText('Unread divider')).toBeInTheDocument()
	})

	it('renders no divider when there is no unread activity in the loaded events', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 10, actorId: 'viewer', data: { content: 'mine' } })],
		})
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 0 })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByLabelText('Unread divider')).not.toBeInTheDocument()
	})

	it('renders the inline reply input', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByTestId('comment-input')).toBeInTheDocument()
	})

	it('passes the unread thread root as the reply target so the composer replies inline', () => {
		// Root id 10 (viewer, read) with one reply id 20 (other, unread).
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'unread', parentEventId: 10 } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'root' } }),
			],
		})
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 1 })} />, {
			wrapper: TestWrapper,
		})
		const lastCall = commentInputCalls.at(-1)
		expect(lastCall?.parentEventId).toBe(10)
	})

	it('falls back to the latest thread root when there is no unread activity', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 30, actorId: 'viewer', data: { content: 'newer root' } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'older root' } }),
			],
		})
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 0 })} />, {
			wrapper: TestWrapper,
		})
		const lastCall = commentInputCalls.at(-1)
		expect(lastCall?.parentEventId).toBe(30)
	})

	it('renders the "New" divider inside the thread when only a reply is unread', () => {
		// Root id 10 (viewer, read) + reply id 20 (other, unread). The divider
		// should attach to the reply, not to the thread root.
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({
					id: 20,
					actorId: 'other',
					data: { content: 'reply unread', parentEventId: 10 },
				}),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'root read' } }),
			],
		})
		const { container } = render(
			<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 1 })} />,
			{ wrapper: TestWrapper },
		)
		const divider = container.querySelector('[aria-label="Unread divider"]')
		expect(divider).not.toBeNull()
		// The divider should be nested under the thread (inside the reply
		// column), not as a direct sibling above the thread root.
		const replyColumn = divider?.closest('.ml-7')
		expect(replyColumn).not.toBeNull()
	})

	it('still renders a divider when unread_count exceeds the loaded events', () => {
		// The server says 5 unread but only 2 non-viewer events are loaded
		// (events query is capped at 50). The divider must still appear,
		// anchored to the oldest non-viewer comment in the loaded window.
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'newer' } }),
				buildComment({ id: 10, actorId: 'other', data: { content: 'older' } }),
			],
		})
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 5 })} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByLabelText('Unread divider')).toBeInTheDocument()
	})

	it('does not mark the thread as read on mount', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 30, actorId: 'other', data: { content: 'newer' } })],
		})
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem({ unread_count: 1 })} />, {
			wrapper: TestWrapper,
		})
		expect(mockMarkReadMutate).not.toHaveBeenCalled()
	})

	it('keeps the title row on its own line at mobile breakpoints', () => {
		// The title cell carries `basis-full` (with `sm:basis-auto`) so a long
		// title at ≤640px gets the full card width and the time/badge/button
		// flow onto the next row. Removing `basis-full` would re-introduce the
		// 375px header overflow that the responsive bet's first-test slice
		// explicitly targets.
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'A very long onboarding bet title that would overflow at 375px',
						type: 'bet',
					}),
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		const titleLink = screen.getByText(/A very long onboarding bet/)
		const titleCell = titleLink.parentElement
		expect(titleCell?.className).toMatch(/basis-full/)
		expect(titleCell?.className).toMatch(/sm:basis-auto/)
		// And the header row itself wraps rather than nowrap-ing into overflow.
		const headerRow = container.querySelector('.border-b')
		expect(headerRow?.className).toMatch(/flex-wrap/)
	})

	// Regression: at 375px a long thread title used to push the unread badge and
	// Mark-as-read button off-screen. `min-w-0 flex-1 truncate` on the title link
	// is what keeps the right-side controls in-frame.
	it('title link is min-w-0 flex-1 truncate so siblings stay in-frame on mobile', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(<UnreadThreadCard workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		const titleLink = screen.getByText('Onboarding A/B')
		expect(titleLink.className).toMatch(/min-w-0/)
		expect(titleLink.className).toMatch(/flex-1/)
		expect(titleLink.className).toMatch(/truncate/)
	})

	it('marks the thread as read when the "Mark as read" button is clicked', async () => {
		const user = userEvent.setup()
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 42, actorId: 'other', data: { content: 'unread' } })],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1, latest_event_id: 42 })}
			/>,
			{ wrapper: TestWrapper },
		)

		await user.click(screen.getByRole('button', { name: /mark as read/i }))
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 42,
		})
	})
})
