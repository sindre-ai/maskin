import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../factories'

const mockUseUnread = vi.fn()
const mockMarkReadMutate = vi.fn()
const mockToast = vi.fn()

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

vi.mock('@/components/foryou/unread-thread-card', () => ({
	UnreadThreadCard: ({ item }: { item: UnreadItem }) => (
		<div data-testid="unread-thread-card">{item.entity_id}</div>
	),
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
		mentions_you: false,
		latest_event_id: 10,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({ id: 'obj-1', title: 'Test Bet' }),
		...overrides,
	}
}

describe('ForYouDashboard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
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

	it('renders the sparse composer with items_count=0 on the empty state (AC-U1)', () => {
		mockUseUnread.mockReturnValue({ data: { items: [] }, isLoading: false })
		render(<ForYouDashboard />)
		const composer = screen.getByTestId('sparse-composer')
		expect(composer).toBeInTheDocument()
		expect(composer).toHaveAttribute('data-items-count', '0')
	})

	it('renders the sparse composer below items when 1 ≤ items.length < 3 (AC-U2)', () => {
		mockUseUnread.mockReturnValue({
			data: { items: [buildUnreadItem({ entity_id: 'obj-1' })] },
			isLoading: false,
		})
		render(<ForYouDashboard />)
		const composer = screen.getByTestId('sparse-composer')
		expect(composer).toHaveAttribute('data-items-count', '1')
	})

	it('hides the sparse composer when items.length >= 3 (AC-U3)', () => {
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
