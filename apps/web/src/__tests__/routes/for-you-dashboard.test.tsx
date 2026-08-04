import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../factories'

const mockUseUnread = vi.fn()
const mockUseBets = vi.fn()
const mockMarkReadMutate = vi.fn()
const mockToast = vi.fn()
const mockSetComposerOpen = vi.fn()
let mockComposerOpen = false

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: (...args: unknown[]) => mockUseUnread(...args),
	useMarkRead: () => ({ mutate: mockMarkReadMutate, isPending: false }),
}))

vi.mock('sonner', () => ({
	toast: (...args: unknown[]) => mockToast(...args),
}))

vi.mock('@/components/foryou/persistent-reply-bar', () => ({
	PersistentReplyBar: ({ activeId }: { activeId: string | null }) => (
		<div data-testid="persistent-reply-bar" data-active-id={activeId ?? ''} />
	),
}))

vi.mock('@/lib/new-conversation-context', () => ({
	useNewConversationComposer: () => ({
		open: mockComposerOpen,
		setOpen: mockSetComposerOpen,
	}),
}))

vi.mock('@/hooks/use-bets', () => ({
	useBets: (...args: unknown[]) => mockUseBets(...args),
}))

vi.mock('@/hooks/use-objects', () => ({
	useCreateObject: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-foryou-redesign-flag', () => ({
	useForyouRedesignFlag: () => false,
}))

vi.mock('@/components/foryou/north-star-prompt-card', () => ({
	NorthStarPromptCard: () => <div data-testid="north-star-prompt-card" />,
}))

vi.mock('@/components/foryou/unread-thread-card', () => ({
	UnreadThreadCard: ({
		item,
		onActivate,
	}: {
		item: UnreadItem
		onActivate: () => void
	}) => (
		<div data-testid="unread-thread-card">
			{item.entity_id}
			<button type="button" onClick={onActivate}>
				activate-{item.entity_id}
			</button>
		</div>
	),
}))

vi.mock('@/components/foryou/onboarding-prompt-card', () => ({
	OnboardingPromptCard: ({ item }: { item: UnreadItem }) => (
		<div data-testid="onboarding-prompt-card">{item.entity_id}</div>
	),
}))

vi.mock('@/components/foryou/new-conversation-composer', () => ({
	NewConversationComposer: ({ open }: { open: boolean }) =>
		open ? <div data-testid="new-conversation-composer" /> : null,
}))

vi.mock('@/components/foryou/sparse-composer', () => ({
	SparseComposer: ({ itemsCount }: { itemsCount: number }) => (
		<div data-testid="sparse-composer" data-items-count={itemsCount} />
	),
}))

vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))

vi.mock('@/components/shared/loading-skeleton', () => ({
	CardSkeleton: () => <div data-testid="card-skeleton" />,
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route, isMarkAllReadShortcut } from '@/routes/_authed/$workspaceId/index'

const ForYouDashboard = (Route as unknown as { component: React.FC }).component

function buildUnreadItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({ id: 'obj-1', title: 'Test Bet' }),
		...overrides,
	}
}

describe('ForYouDashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default: workspace has existing bets so NorthStarPromptCard stays hidden
		mockUseBets.mockReturnValue({ data: [{ id: 'bet-1' }], isLoading: false })
		mockComposerOpen = false
	})

	it('shows loading skeletons while loading', () => {
		mockUseUnread.mockReturnValue({ data: undefined, isLoading: true })
		render(<ForYouDashboard />)
		expect(screen.getAllByTestId('card-skeleton').length).toBeGreaterThan(0)
	})

	it('shows the empty state when there are no unread threads', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		expect(screen.getByText('All caught up')).toBeInTheDocument()
	})

	it('renders one UnreadThreadCard per unread item', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [buildUnreadItem({ entity_id: 'obj-1' }), buildUnreadItem({ entity_id: 'obj-2' })],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		expect(screen.getAllByTestId('unread-thread-card')).toHaveLength(2)
		expect(screen.getByText('obj-1')).toBeInTheDocument()
		expect(screen.getByText('obj-2')).toBeInTheDocument()
	})

	it('sorts mentioning_unread_count items above non-mention items', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'fyi-1', mentioning_unread_count: 0 }),
					buildUnreadItem({ entity_id: 'mention-1', mentioning_unread_count: 1 }),
					buildUnreadItem({ entity_id: 'fyi-2', mentioning_unread_count: 0 }),
					buildUnreadItem({ entity_id: 'mention-2', mentioning_unread_count: 1 }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		const rendered = screen
			.getAllByTestId('unread-thread-card')
			.map((el) => el.textContent?.replace(/activate-\S+/, ''))
		expect(rendered).toEqual(['mention-1', 'mention-2', 'fyi-1', 'fyi-2'])
	})

	it('"Mark all as read" skips onboarding prompt cards, committed on auto-close', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({
						entity_type: 'object',
						entity_id: 'onboarding-1',
						latest_event_id: 99,
						object: buildObjectResponse({ id: 'onboarding-1', type: 'onboarding_session' }),
					}),
					buildUnreadItem({
						entity_type: 'object',
						entity_id: 'obj-1',
						latest_event_id: 11,
					}),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: /mark all as read/i }))
		const [, opts] = mockToast.mock.calls[0] as [string, { onAutoClose: () => void }]
		act(() => opts.onAutoClose())

		expect(mockMarkReadMutate).toHaveBeenCalledTimes(1)
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 11,
		})
	})

	// ⌘N itself is owned by CommandPalette (see command-palette.test.tsx) — it
	// opens this page's composer via the shared NewConversationComposer context.
	// Here we only cover this page's own trigger: the "New" header button.
	it('clicking the "New" button opens the new-conversation composer', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
		expect(mockSetComposerOpen).toHaveBeenCalledWith(true)
	})

	it('renders the new-conversation composer as open when the shared context reports open', () => {
		mockComposerOpen = true
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		expect(screen.getByTestId('new-conversation-composer')).toBeInTheDocument()
	})

	it('renders the sparse composer with items_count=0 on the empty state', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		const composer = screen.getByTestId('sparse-composer')
		expect(composer).toBeInTheDocument()
		expect(composer).toHaveAttribute('data-items-count', '0')
	})

	it('renders the sparse composer below items when 1 ≤ items.length < 3', () => {
		mockUseUnread.mockReturnValue({
			data: { items: [buildUnreadItem({ entity_id: 'obj-1' })] },
			isLoading: false,
		})
		render(<ForYouDashboard />)
		const composer = screen.getByTestId('sparse-composer')
		expect(composer).toHaveAttribute('data-items-count', '1')
	})

	it('clears the active selection when the active item drops out of the feed', () => {
		const items = [buildUnreadItem({ entity_id: 'obj-1' }), buildUnreadItem({ entity_id: 'obj-2' })]
		mockUseUnread.mockReturnValue({ data: { items }, isLoading: false })
		const { rerender } = render(<ForYouDashboard />)

		fireEvent.click(screen.getByRole('button', { name: 'activate-obj-1' }))
		expect(screen.getByTestId('persistent-reply-bar')).toHaveAttribute('data-active-id', 'obj-1')

		// obj-1 drops out of the feed — e.g. a quick-reply chip's own mark-read
		// call zeroed its unread_count, so the next refetch no longer includes it.
		mockUseUnread.mockReturnValue({ data: { items: [items[1]] }, isLoading: false })
		rerender(<ForYouDashboard />)

		expect(screen.getByTestId('persistent-reply-bar')).toHaveAttribute('data-active-id', '')
	})

	it('keeps the active selection when the active item is still in the feed', () => {
		const items = [buildUnreadItem({ entity_id: 'obj-1' }), buildUnreadItem({ entity_id: 'obj-2' })]
		mockUseUnread.mockReturnValue({ data: { items }, isLoading: false })
		const { rerender } = render(<ForYouDashboard />)

		fireEvent.click(screen.getByRole('button', { name: 'activate-obj-1' }))
		mockUseUnread.mockReturnValue({ data: { items }, isLoading: false })
		rerender(<ForYouDashboard />)

		expect(screen.getByTestId('persistent-reply-bar')).toHaveAttribute('data-active-id', 'obj-1')
	})

	it('hides the sparse composer when items.length >= 3', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'obj-1' }),
					buildUnreadItem({ entity_id: 'obj-2' }),
					buildUnreadItem({ entity_id: 'obj-3' }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		expect(screen.queryByTestId('sparse-composer')).not.toBeInTheDocument()
	})

	it('renders "Mark all as read" button with a running count when items > 0', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [buildUnreadItem({ entity_id: 'obj-1' }), buildUnreadItem({ entity_id: 'obj-2' })],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		expect(screen.getByRole('button', { name: /mark all as read \(2\)/i })).toBeInTheDocument()
	})

	it('does not render "Mark all as read" button on the empty state', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		expect(screen.queryByRole('button', { name: /mark all as read/i })).not.toBeInTheDocument()
	})

	it('clicking "Mark all as read" hides items and opens a toast with an Undo action', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [buildUnreadItem({ entity_id: 'obj-1' }), buildUnreadItem({ entity_id: 'obj-2' })],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: /mark all as read/i }))

		// Items disappear from the list immediately (optimistic hide).
		expect(screen.queryAllByTestId('unread-thread-card')).toHaveLength(0)

		// Sonner was invoked with a 15s Undo action.
		expect(mockToast).toHaveBeenCalledTimes(1)
		const [message, opts] = mockToast.mock.calls[0] as [
			string,
			{
				duration: number
				action: { label: string; onClick: () => void }
				onAutoClose?: () => void
				onDismiss?: () => void
			},
		]
		expect(message).toContain('2 threads')
		expect(opts.duration).toBe(15_000)
		expect(opts.action.label).toBe('Undo')
		// No mutations have fired yet — they wait for auto-close/dismiss.
		expect(mockMarkReadMutate).not.toHaveBeenCalled()
	})

	it('Undo restores the hidden items and fires no mutations', () => {
		mockUseUnread.mockReturnValue({
			data: { items: [buildUnreadItem({ entity_id: 'obj-1' })] },
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: /mark all as read/i }))
		const [, opts] = mockToast.mock.calls[0] as [
			string,
			{
				action: { onClick: () => void }
				onAutoClose?: () => void
				onDismiss?: () => void
			},
		]
		act(() => {
			opts.action.onClick()
			// Even if the toast follows up with an auto-close/dismiss after undo,
			// the settled guard must prevent a stale commit.
			opts.onAutoClose?.()
			opts.onDismiss?.()
		})

		expect(screen.getAllByTestId('unread-thread-card')).toHaveLength(1)
		expect(mockMarkReadMutate).not.toHaveBeenCalled()
	})

	it('auto-close commits the mutations for every snapshotted item', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'obj-1', latest_event_id: 11 }),
					buildUnreadItem({ entity_id: 'obj-2', latest_event_id: 22 }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: /mark all as read/i }))
		const [, opts] = mockToast.mock.calls[0] as [string, { onAutoClose: () => void }]
		act(() => opts.onAutoClose())

		expect(mockMarkReadMutate).toHaveBeenCalledTimes(2)
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-1',
			lastEventId: 11,
		})
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-2',
			lastEventId: 22,
		})
	})

	it('skips items whose latest_event_id is null so we never send lastEventId=0', () => {
		mockUseUnread.mockReturnValue({
			data: {
				items: [
					buildUnreadItem({ entity_id: 'obj-1', latest_event_id: null }),
					buildUnreadItem({ entity_id: 'obj-2', latest_event_id: 22 }),
				],
			},
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.click(screen.getByRole('button', { name: /mark all as read/i }))
		const [, opts] = mockToast.mock.calls[0] as [string, { onAutoClose: () => void }]
		act(() => opts.onAutoClose())
		expect(mockMarkReadMutate).toHaveBeenCalledTimes(1)
		expect(mockMarkReadMutate).toHaveBeenCalledWith({
			entityType: 'object',
			entityId: 'obj-2',
			lastEventId: 22,
		})
	})

	it('Alt+U triggers the bulk action', () => {
		mockUseUnread.mockReturnValue({
			data: { items: [buildUnreadItem({ entity_id: 'obj-1' })] },
			isLoading: false,
		})
		render(<ForYouDashboard />)
		fireEvent.keyDown(window, { key: 'u', code: 'KeyU', altKey: true })
		expect(mockToast).toHaveBeenCalledTimes(1)
	})
})

describe('isMarkAllReadShortcut', () => {
	function makeEvent(overrides: Partial<KeyboardEventInit> & { target?: EventTarget }) {
		const { target, ...rest } = overrides
		return {
			key: 'u',
			code: 'KeyU',
			altKey: true,
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			target: target ?? document.body,
			...rest,
		} as unknown as KeyboardEvent
	}

	it('matches Alt+U with no other modifier', () => {
		expect(isMarkAllReadShortcut(makeEvent({}))).toBe(true)
	})

	it('matches Option+U on macOS even when the OS emits a dead-key character', () => {
		// macOS Option+U emits key='¨' (dead diaeresis) but code stays 'KeyU'.
		expect(isMarkAllReadShortcut(makeEvent({ key: '¨' } as KeyboardEventInit))).toBe(true)
	})

	it('rejects plain U without Alt', () => {
		expect(isMarkAllReadShortcut(makeEvent({ altKey: false }))).toBe(false)
	})

	it('rejects Ctrl+Alt+U and Cmd+Alt+U', () => {
		expect(isMarkAllReadShortcut(makeEvent({ ctrlKey: true }))).toBe(false)
		expect(isMarkAllReadShortcut(makeEvent({ metaKey: true }))).toBe(false)
	})

	it('is suppressed when an input is focused', () => {
		const input = document.createElement('input')
		expect(isMarkAllReadShortcut(makeEvent({ target: input }))).toBe(false)
	})

	it('is suppressed when a textarea is focused', () => {
		const textarea = document.createElement('textarea')
		expect(isMarkAllReadShortcut(makeEvent({ target: textarea }))).toBe(false)
	})

	it('is suppressed when a contenteditable element is focused', () => {
		const div = document.createElement('div')
		div.setAttribute('contenteditable', 'true')
		expect(isMarkAllReadShortcut(makeEvent({ target: div }))).toBe(false)
	})
})
