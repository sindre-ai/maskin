import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { EventResponse, UnreadItem } from '@/lib/api'
import { buildEventResponse, buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const trackForyouCardShownMock = vi.fn()
const trackForyouCardActionMock = vi.fn()

vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackForyouCardShown: (...args: unknown[]) => trackForyouCardShownMock(...args),
		trackForyouCardAction: (...args: unknown[]) => trackForyouCardActionMock(...args),
	}
})

const mockUseEntityEvents = vi.fn()
const mockMarkReadMutate = vi.fn()
const mockUseMarkRead = vi.fn(() => ({ mutate: mockMarkReadMutate, isPending: false }))
const mockMarkUnreadMutate = vi.fn()
const mockUseMarkUnread = vi.fn(() => ({ mutate: mockMarkUnreadMutate, isPending: false }))
const mockCreateCommentMutate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: (...args: unknown[]) => mockUseEntityEvents(...args),
	useCreateComment: () => ({ mutate: mockCreateCommentMutate, isPending: false }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useMarkRead: () => mockUseMarkRead(),
	useMarkUnread: () => mockUseMarkUnread(),
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
		mentioning_unread_count: 0,
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

const noop = () => {}

describe('UnreadThreadCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMarkReadMutate.mockReset()
		mockMarkUnreadMutate.mockReset()
		mockCreateCommentMutate.mockReset()
		trackForyouCardShownMock.mockReset()
		trackForyouCardActionMock.mockReset()
	})

	it('renders the object title and unread count', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 3 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Onboarding A/B')).toBeInTheDocument()
		expect(screen.getByLabelText('3 unread')).toBeInTheDocument()
	})

	it('renders a dot+word status pill in the card head using the object status', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'Onboarding A/B',
						type: 'bet',
						status: 'in_progress',
					}),
				})}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const pill = screen.getByLabelText('Status in progress')
		expect(pill).toBeInTheDocument()
		expect(pill.className).toContain('text-status-in_progress-text')
		expect(pill.querySelector('[data-testid="status-dot"]')).not.toBeNull()
	})

	it('renders the object body content as a 2-line insight preview', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'Onboarding A/B',
						type: 'bet',
						content: 'This is the insight preview text that should render above the take.',
					}),
				})}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const preview = screen.getByText(/insight preview text/)
		expect(preview).toBeInTheDocument()
		expect(preview.className).toMatch(/line-clamp-2/)
	})

	it('renders a "Mentioned" flag when at least one unread event mentions the viewer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentioning_unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByLabelText('Mentioned')).toBeInTheDocument()
	})

	it('promotes the unread left-border accent to warning tone when the viewer is @mentioned', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentioning_unread_count: 1, unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).toMatch(/border-l-warning/)
	})

	it('applies the default primary left-border accent for unread non-mention items', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentioning_unread_count: 0, unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).toMatch(/border-l-primary/)
	})

	it('omits the unread left-border accent entirely when the thread has no unread events', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentioning_unread_count: 0, unread_count: 0 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).not.toMatch(/border-l-primary/)
		expect(card.className).not.toMatch(/border-l-warning/)
	})

	it('omits the "Mentioned" flag when no unread events mention the viewer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ mentioning_unread_count: 0 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByLabelText('Mentioned')).not.toBeInTheDocument()
	})

	it('renders a "New" divider before the first thread containing unread activity', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 30, actorId: 'other', data: { content: 'newer' } }),
				buildComment({ id: 20, actorId: 'other', data: { content: 'middle' } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'oldest' } }),
			],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 2 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByLabelText('Unread divider')).toBeInTheDocument()
	})

	it('renders no divider when there is no unread activity in the loaded events', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 10, actorId: 'viewer', data: { content: 'mine' } })],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 0 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByLabelText('Unread divider')).not.toBeInTheDocument()
	})

	it('renders no per-card reply textarea', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
	})

	it('renders a Reply button in the footer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /reply/i })).toBeInTheDocument()
	})

	it('shows "Replying…" on the Reply button when isActive is true', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={true}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /replying/i })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^reply$/i })).not.toBeInTheDocument()
	})

	it('applies an active-selection background tint when isActive is true', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={true}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		// The outer wrapper is the firstChild; the inner card is the second child of the wrapper.
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).toMatch(/bg-secondary/)
	})

	it('does not apply the active-selection tint when isActive is false', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).not.toMatch(/bg-secondary\/40/)
	})

	it('calls onActivate when the card body is clicked', async () => {
		const user = userEvent.setup()
		const onActivate = vi.fn()
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={onActivate}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		// Click on the inner card (second child of the wrapper)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		await user.click(card)
		expect(onActivate).toHaveBeenCalled()
	})

	it('calls onActivate when the Reply button is clicked', async () => {
		const user = userEvent.setup()
		const onActivate = vi.fn()
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={onActivate}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: /reply/i }))
		expect(onActivate).toHaveBeenCalled()
	})

	it('renders the "New" divider inside the thread when only a reply is unread', () => {
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
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const divider = container.querySelector('[aria-label="Unread divider"]')
		expect(divider).not.toBeNull()
		const replyColumn = divider?.closest('.ml-7')
		expect(replyColumn).not.toBeNull()
	})

	it('still renders a divider when unread_count exceeds the loaded events', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'newer' } }),
				buildComment({ id: 10, actorId: 'other', data: { content: 'older' } }),
			],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 5 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByLabelText('Unread divider')).toBeInTheDocument()
	})

	it('does not mark the thread as read on mount', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [buildComment({ id: 30, actorId: 'other', data: { content: 'newer' } })],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(mockMarkReadMutate).not.toHaveBeenCalled()
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
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)

		// Two "Mark as read" buttons exist (corner ✓ + footer). Either one drives
		// the same handler, so we can pick the footer button by index.
		const buttons = screen.getAllByRole('button', { name: /mark as read/i })
		await user.click(buttons[buttons.length - 1])
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 42,
		})
	})

	it('shows the bet context pill for bet-type objects', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({ id: 'obj-1', title: 'My Bet', type: 'bet' }),
				})}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('B')).toBeInTheDocument()
	})

	it('omits the bet context pill for non-bet objects', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({ id: 'obj-1', title: 'My Task', type: 'task' }),
				})}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByText('B')).not.toBeInTheDocument()
	})

	it('renders the swipe-to-mark-read green background element', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		// The green reveal background is the first child of the outer wrapper
		const wrapper = container.firstChild as HTMLElement
		const swipeBg = wrapper.firstChild as HTMLElement
		expect(swipeBg).toHaveAttribute('aria-hidden')
	})

	it('renders Mark as read button in the card footer', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(screen.getAllByRole('button', { name: /mark as read/i }).length).toBeGreaterThan(0)
	})

	it('fires create-comment mutation with the right payload when a quick-reply chip is tapped', async () => {
		const user = userEvent.setup()
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem()}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: 'On it' }))
		expect(mockCreateCommentMutate).toHaveBeenCalledWith(
			{ entity_id: 'obj-1', content: 'On it', parent_event_id: undefined },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('threads a quick-reply chip under the first unread root when unread activity exists', async () => {
		const user = userEvent.setup()
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'unread', parentEventId: 10 } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'root' } }),
			],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: 'On it' }))
		expect(mockCreateCommentMutate).toHaveBeenCalledWith(
			{ entity_id: 'obj-1', content: 'On it', parent_event_id: 10 },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('threads a quick-reply chip under the latest root when nothing is unread', async () => {
		const user = userEvent.setup()
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 30, actorId: 'viewer', data: { content: 'newer root' } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'older root' } }),
			],
		})
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 0 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: 'On it' }))
		expect(mockCreateCommentMutate).toHaveBeenCalledWith(
			{ entity_id: 'obj-1', content: 'On it', parent_event_id: 30 },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('reports the reply target to the parent only while active, and when it changes', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'unread', parentEventId: 10 } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'root' } }),
			],
		})
		const onReplyTargetChange = vi.fn()
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={onReplyTargetChange}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(onReplyTargetChange).not.toHaveBeenCalled()
	})

	it('reports the first-unread reply target to the parent while active', () => {
		mockUseEntityEvents.mockReturnValue({
			data: [
				buildComment({ id: 20, actorId: 'other', data: { content: 'unread', parentEventId: 10 } }),
				buildComment({ id: 10, actorId: 'viewer', data: { content: 'root' } }),
			],
		})
		const onReplyTargetChange = vi.fn()
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1 })}
				isActive={true}
				onActivate={noop}
				onReplyTargetChange={onReplyTargetChange}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(onReplyTargetChange).toHaveBeenCalledWith(10)
	})

	// Regression lock for the v4 "no height cap, page scroll" direction. The shipped
	// version on `main` had `h-72 overflow-y-auto sm:h-96` on the thread body, which
	// users hit as "cards too short — forces internal scrolling". A reviewer who
	// re-introduces a per-card scroll body or a fixed-height clamp should trip this
	// test, not Slack feedback.
	it('does not clamp card or inline thread height (no inner scrollbars)', () => {
		const longThread = Array.from({ length: 25 }, (_, i) =>
			buildComment({ id: 100 + i, actorId: 'other', data: { content: `comment ${i}` } }),
		)
		mockUseEntityEvents.mockReturnValue({ data: longThread })

		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 25, latest_event_id: 124 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)

		// The quick-reply chip strip is intentionally a horizontal scroller; exempt it
		// (and its descendants) so the assertion targets vertical clamps on the card
		// and inline thread surface.
		const chipStrip = container.querySelector('.overflow-x-auto')
		const all = Array.from(container.querySelectorAll<HTMLElement>('*'))
		const offenders = all
			.filter((el) => !chipStrip || (el !== chipStrip && !chipStrip.contains(el)))
			.filter((el) => {
				const cls = el.className
				if (typeof cls !== 'string') return false
				return (
					/\bmax-h-/.test(cls) ||
					/\bh-72\b/.test(cls) ||
					/\bh-96\b/.test(cls) ||
					/\boverflow-y-(auto|scroll)\b/.test(cls) ||
					(/\boverflow-(auto|scroll)\b/.test(cls) && !/\boverflow-x-(auto|scroll)\b/.test(cls))
				)
			})
		expect(offenders.map((el) => el.className)).toEqual([])
	})

	it('marks the thread read after a quick-reply chip send succeeds', async () => {
		mockCreateCommentMutate.mockImplementation(
			(_args: unknown, opts?: { onSuccess?: () => void }) => {
				opts?.onSuccess?.()
			},
		)
		const user = userEvent.setup()
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ latest_event_id: 20 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		await user.click(screen.getByRole('button', { name: 'On it' }))
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 20,
		})
	})

	it('renders the latest-activity timestamp in font-mono tabular-nums (AC-U2)', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ latest_activity_at: new Date(Date.now() - 5 * 60_000).toISOString() })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const timeEl = screen.getByText(/ago|now/) as HTMLElement
		expect(timeEl.tagName).toBe('TIME')
		expect(timeEl).toHaveClass('font-mono')
		expect(timeEl).toHaveClass('tabular-nums')
	})

	// Regression lock for the minimal redesign: title is left-aligned on its own row
	// (not squeezed into the head with badges and controls), so a long title can't
	// push time/badges off-screen at 375px. `block truncate` on the title link
	// enforces the row and clips overflow.
	it('places the title on its own row with block + truncate', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'A very long onboarding bet title that would overflow at 375px',
						type: 'bet',
					}),
				})}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const titleLink = screen.getByText(/A very long onboarding bet/)
		expect(titleLink.className).toMatch(/\bblock\b/)
		expect(titleLink.className).toMatch(/truncate/)
	})

	it('renders the per-card dismiss button in the card head, labelled Mark as read', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ latest_event_id: 55 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		// Two "Mark as read" buttons now: the corner ✓ (hidden on touch via can-hover:)
		// and the always-visible footer button. Both share the same aria-label so
		// keyboard users find either.
		const dismissButtons = screen.getAllByRole('button', { name: /mark as read/i })
		expect(dismissButtons.length).toBeGreaterThanOrEqual(2)
	})

	it('renders the Blue Envelope reveal on a read card and mark-read reveal on an unread card', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })

		const readRender = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 0, mentioning_unread_count: 0 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const unreadReveal = readRender.getByTestId('mark-unread-reveal')
		expect(unreadReveal.className).toContain('bg-status-in_progress-bg')
		expect(unreadReveal.className).toContain('text-status-in_progress-text')
		expect(unreadReveal.textContent).toMatch(/Mark unread/)
		expect(readRender.queryByTestId('mark-read-reveal')).toBeNull()
		readRender.unmount()

		const unreadRender = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 3 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const readReveal = unreadRender.getByTestId('mark-read-reveal')
		expect(readReveal.className).toContain('bg-status-active-bg')
		expect(readReveal.textContent).toMatch(/Mark read/)
		expect(unreadRender.queryByTestId('mark-unread-reveal')).toBeNull()
	})

	it('applies the muted read-card style (opacity + hairline left rail) when unread_count is 0', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 0, mentioning_unread_count: 0 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		// The inner card is the second child of the outer wrapper (the first is
		// the swipe-reveal overlay).
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).toMatch(/opacity-\[0\.78\]/)
		expect(card.className).toMatch(/border-l-border/)
		// The unread accent rails must not fire on a read card.
		expect(card.className).not.toMatch(/border-l-primary/)
		expect(card.className).not.toMatch(/border-l-warning/)
	})

	it('does not apply the muted read style when the card is still unread', () => {
		mockUseEntityEvents.mockReturnValue({ data: [] })
		const { container } = render(
			<UnreadThreadCard
				workspaceId="ws-1"
				item={buildItem({ unread_count: 2 })}
				isActive={false}
				onActivate={noop}
				onReplyTargetChange={noop}
			/>,
			{ wrapper: TestWrapper },
		)
		const card = container.firstChild?.childNodes[1] as HTMLElement
		expect(card.className).not.toMatch(/opacity-\[0\.78\]/)
		expect(card.className).not.toMatch(/border-l-border/)
	})

	// The three action-UI kinds — the load-bearing distinction the bet is
	// wagering on. T6 reads the same `classifyCardKind` helper to emit
	// `foryou_card_shown` / `foryou_card_action`, so this classification is a
	// contract shared with the analytics pipeline.
	describe('card kinds', () => {
		it('classifies a bet in in_review as a decision card and renders the shaded footer', () => {
			mockUseEntityEvents.mockReturnValue({ data: [] })
			const { container } = render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'in_review' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)
			const card = container.querySelector('[data-card-kind]') as HTMLElement
			expect(card.dataset.cardKind).toBe('decision')
			const footer = screen.getByTestId('decision-footer')
			expect(footer.className).toContain('bg-status-in_review-bg')
			expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Send back' })).toBeInTheDocument()
			expect(screen.queryByTestId('chip-row')).not.toBeInTheDocument()
		})

		it('classifies a task in in_review as a sign_off card and renders the chip-row', () => {
			mockUseEntityEvents.mockReturnValue({ data: [] })
			const { container } = render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'task', status: 'in_review' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)
			const card = container.querySelector('[data-card-kind]') as HTMLElement
			expect(card.dataset.cardKind).toBe('sign_off')
			expect(screen.getByTestId('chip-row')).toBeInTheDocument()
			expect(screen.queryByTestId('decision-footer')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Sign off' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Snooze 24h' })).toBeInTheDocument()
		})

		it('classifies a proposed bet (signal status) as a proposed_bet card', () => {
			mockUseEntityEvents.mockReturnValue({ data: [] })
			const { container } = render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'signal' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)
			const card = container.querySelector('[data-card-kind]') as HTMLElement
			expect(card.dataset.cardKind).toBe('proposed_bet')
			expect(screen.getByRole('button', { name: 'Open bet' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Refine first' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
		})

		it('exposes stable data-action-id values on chip and decision buttons so T6 can wire without restructuring', () => {
			mockUseEntityEvents.mockReturnValue({ data: [] })
			const { rerender } = render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'in_review' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute(
				'data-action-id',
				'approve',
			)
			rerender(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'task', status: 'in_review' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
			)
			expect(screen.getByRole('button', { name: 'Sign off' })).toHaveAttribute(
				'data-action-id',
				'sign_off',
			)
		})

		it('routes a decision-footer click through the same comment+mark-read pipeline as chips', async () => {
			mockCreateCommentMutate.mockImplementation(
				(_args: unknown, opts?: { onSuccess?: () => void }) => {
					opts?.onSuccess?.()
				},
			)
			const user = userEvent.setup()
			mockUseEntityEvents.mockReturnValue({ data: [] })
			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'in_review' }),
						latest_event_id: 42,
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)
			await user.click(screen.getByRole('button', { name: 'Approve' }))
			expect(mockCreateCommentMutate).toHaveBeenCalledWith(
				{ entity_id: 'obj-1', content: 'Approve', parent_event_id: undefined },
				expect.objectContaining({ onSuccess: expect.any(Function) }),
			)
			expect(mockMarkReadMutate).toHaveBeenCalledWith({
				entityType: 'object',
				entityId: 'obj-1',
				lastEventId: 42,
			})
		})

		it('hides both the chip-row and the decision footer in list mode, on every kind', () => {
			mockUseEntityEvents.mockReturnValue({ data: [] })
			const { rerender } = render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'bet', status: 'in_review' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
					mode="list"
				/>,
				{ wrapper: TestWrapper },
			)
			expect(screen.queryByTestId('decision-footer')).not.toBeInTheDocument()
			expect(screen.queryByTestId('chip-row')).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()

			rerender(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						object: buildObjectResponse({ id: 'obj-1', type: 'task', status: 'in_review' }),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
					mode="list"
				/>,
			)
			expect(screen.queryByTestId('chip-row')).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Sign off' })).not.toBeInTheDocument()
		})
	})

	describe('PostHog instrumentation (T6)', () => {
		// Success metric = count(foryou_card_action) / count(foryou_card_shown) on
		// matching card_id. Both events must ride the same identity or the ratio
		// silently reads wrong at rollout — these tests are the wire check.

		const originalIntersectionObserver = globalThis.IntersectionObserver

		function useEagerIntersectionObserver() {
			class EagerObserver {
				private callback: IntersectionObserverCallback
				constructor(cb: IntersectionObserverCallback) {
					this.callback = cb
				}
				observe(target: Element) {
					this.callback(
						[{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
						this as unknown as IntersectionObserver,
					)
				}
				unobserve() {}
				disconnect() {}
				takeRecords() {
					return []
				}
			}
			globalThis.IntersectionObserver = EagerObserver as unknown as typeof IntersectionObserver
		}

		afterEach(() => {
			globalThis.IntersectionObserver = originalIntersectionObserver
		})

		it('emits foryou_card_shown once when the card first intersects the viewport, keyed by classifyCardKind', () => {
			useEagerIntersectionObserver()
			mockUseEntityEvents.mockReturnValue({ data: [] })

			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						entity_id: 'bet-42',
						object: buildObjectResponse({
							id: 'bet-42',
							title: 'Bet',
							type: 'bet',
							status: 'in_review',
						}),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)

			expect(trackForyouCardShownMock).toHaveBeenCalledTimes(1)
			expect(trackForyouCardShownMock).toHaveBeenCalledWith({
				card_kind: 'decision',
				card_id: 'bet-42',
			})
		})

		it('does not emit foryou_card_shown when the card never becomes visible', () => {
			// Default stub observer (from setup.ts) never fires — mirrors a card
			// that mounts below the fold and is scrolled past before intersection.
			mockUseEntityEvents.mockReturnValue({ data: [] })

			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem()}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)

			expect(trackForyouCardShownMock).not.toHaveBeenCalled()
		})

		it('emits foryou_card_action with action_id=reply when the Reply button is clicked', async () => {
			const user = userEvent.setup()
			mockUseEntityEvents.mockReturnValue({ data: [] })

			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						entity_id: 'bet-1',
						object: buildObjectResponse({
							id: 'bet-1',
							title: 'Bet',
							type: 'bet',
							status: 'in_review',
						}),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)

			await user.click(screen.getByRole('button', { name: /reply/i }))

			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'decision',
				card_id: 'bet-1',
				action_id: 'reply',
			})
		})

		it('emits foryou_card_action with action_id=mark_read_button from the footer Mark-as-read', async () => {
			const user = userEvent.setup()
			mockUseEntityEvents.mockReturnValue({
				data: [buildComment({ id: 42, actorId: 'other', data: { content: 'unread' } })],
			})

			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						entity_id: 'task-9',
						unread_count: 1,
						latest_event_id: 42,
						object: buildObjectResponse({
							id: 'task-9',
							title: 'Task',
							type: 'task',
							status: 'in_review',
						}),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)

			const buttons = screen.getAllByRole('button', { name: /^mark as read$/i })
			// Footer Mark-as-read is the last matching button; the corner ✓ uses
			// the same aria-label but sits earlier in DOM order.
			await user.click(buttons[buttons.length - 1])

			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'sign_off',
				card_id: 'task-9',
				action_id: 'mark_read_button',
			})
		})

		it('emits foryou_card_action with the CardAction id when a sign_off chip is clicked', async () => {
			const user = userEvent.setup()
			mockUseEntityEvents.mockReturnValue({ data: [] })

			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						entity_id: 'task-3',
						object: buildObjectResponse({
							id: 'task-3',
							title: 'Task',
							type: 'task',
							status: 'in_review',
						}),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)

			await user.click(screen.getByRole('button', { name: 'Snooze 24h' }))

			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'sign_off',
				card_id: 'task-3',
				action_id: 'snooze_24h',
			})
		})

		it('emits foryou_card_action from decision-footer buttons with their stable action_id', async () => {
			const user = userEvent.setup()
			mockUseEntityEvents.mockReturnValue({ data: [] })

			render(
				<UnreadThreadCard
					workspaceId="ws-1"
					item={buildItem({
						entity_id: 'bet-9',
						object: buildObjectResponse({
							id: 'bet-9',
							title: 'Bet',
							type: 'bet',
							status: 'in_review',
						}),
					})}
					isActive={false}
					onActivate={noop}
					onReplyTargetChange={noop}
				/>,
				{ wrapper: TestWrapper },
			)

			await user.click(screen.getByRole('button', { name: 'Approve' }))

			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'decision',
				card_id: 'bet-9',
				action_id: 'approve',
			})
		})
	})
})
