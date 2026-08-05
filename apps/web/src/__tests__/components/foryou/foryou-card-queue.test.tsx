import { type Ref, act, forwardRef, useImperativeHandle } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const commitMock = vi.fn()
const skipMock = vi.fn()

interface StubCallbacks {
	onProcessed: (key: string) => void
	onRestored: (key: string) => void
	onCommitScheduled: (key: string) => void
	onCommitSettled: (key: string) => void
}

// Keyed by item queue key so two cards (current + a settling one) can be
// mounted simultaneously without one stub instance's callbacks clobbering
// the other's, mirroring what the real orchestrator now renders.
const callbacksByKey = new Map<string, StubCallbacks>()

interface StubProps extends StubCallbacks {
	workspaceId: string
	item: UnreadItem
}

function itemQueueKeyImpl(item: UnreadItem): string {
	return `${item.entity_type}:${item.entity_id}`
}

function fireProcessed(key: string) {
	callbacksByKey.get(key)?.onProcessed(key)
}
function fireRestored(key: string) {
	callbacksByKey.get(key)?.onRestored(key)
}
function fireCommitScheduled(key: string) {
	callbacksByKey.get(key)?.onCommitScheduled(key)
}
function fireCommitSettled(key: string) {
	callbacksByKey.get(key)?.onCommitSettled(key)
}

vi.mock('@/components/foryou/foryou-queue-card', () => ({
	itemQueueKey: (item: UnreadItem) => itemQueueKeyImpl(item),
	ForYouQueueCard: forwardRef((props: StubProps, ref: Ref<{ commit: () => void; skip: () => void }>) => {
		const key = itemQueueKeyImpl(props.item)
		callbacksByKey.set(key, {
			onProcessed: props.onProcessed,
			onRestored: props.onRestored,
			onCommitScheduled: props.onCommitScheduled,
			onCommitSettled: props.onCommitSettled,
		})
		useImperativeHandle(ref, () => ({ commit: commitMock, skip: skipMock }))
		return (
			<div data-testid="stub-card" data-key={key}>
				{props.item.entity_id}
			</div>
		)
	}),
}))

import { ForYouCardQueue } from '@/components/foryou/foryou-card-queue'

function buildItem(entityId: string, overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: entityId,
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 10,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({ id: entityId, title: `Item ${entityId}`, type: 'bet', status: 'active' }),
		...overrides,
	}
}

describe('ForYouCardQueue', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		callbacksByKey.clear()
	})

	it('renders the empty state with brief and loops links when the queue is empty', () => {
		render(<ForYouCardQueue workspaceId="ws-1" queue={[]} />)

		expect(screen.getByText("You're caught up")).toBeInTheDocument()
		expect(screen.queryByTestId('stub-card')).not.toBeInTheDocument()

		const briefLink = screen.getByRole('link', { name: "Today's brief" })
		expect(briefLink).toHaveAttribute('to', '/$workspaceId/briefing')

		const loopsLink = screen.getByRole('link', { name: /review loops/i })
		expect(loopsLink).toHaveAttribute('to', '/$workspaceId/objects')
	})

	it('renders the first item in the queue and the remaining count', () => {
		const queue = [buildItem('a'), buildItem('b')]
		render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		expect(screen.getByTestId('stub-card')).toHaveTextContent('a')
		expect(screen.getByText('2 items left')).toBeInTheDocument()
	})

	it('shows singular "item" phrasing when only one remains', () => {
		render(<ForYouCardQueue workspaceId="ws-1" queue={[buildItem('a')]} />)
		expect(screen.getByText('1 item left')).toBeInTheDocument()
	})

	it('advances to the next item once the current card reports onProcessed, and shows the empty state after the last one', () => {
		const queue = [buildItem('a'), buildItem('b')]
		render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		expect(screen.getByTestId('stub-card')).toHaveTextContent('a')

		act(() => {
			fireProcessed(itemQueueKeyImpl(queue[0]))
		})

		expect(screen.getByTestId('stub-card')).toHaveTextContent('b')
		expect(screen.getByText('1 item left')).toBeInTheDocument()

		act(() => {
			fireProcessed(itemQueueKeyImpl(queue[1]))
		})

		expect(screen.getByText("You're caught up")).toBeInTheDocument()
	})

	it('restores a processed item back to current when the card reports onRestored (undo)', () => {
		const queue = [buildItem('a'), buildItem('b')]
		render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		act(() => {
			fireProcessed(itemQueueKeyImpl(queue[0]))
		})
		expect(screen.getByTestId('stub-card')).toHaveTextContent('b')

		act(() => {
			fireRestored(itemQueueKeyImpl(queue[0]))
		})

		expect(screen.getByTestId('stub-card')).toHaveTextContent('a')
		expect(screen.getByText('2 items left')).toBeInTheDocument()
	})

	it('keeps a card mounted (hidden) after the queue advances past it while its deferred commit is pending, and drops it once the commit settles', () => {
		const queue = [buildItem('a'), buildItem('b')]
		render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		act(() => {
			fireCommitScheduled(itemQueueKeyImpl(queue[0]))
			fireProcessed(itemQueueKeyImpl(queue[0]))
		})

		// Both cards are still mounted — "a" only hidden, not unmounted, so its
		// still-running use-swipe-to-mark-read commit timer isn't cancelled.
		expect(screen.getAllByTestId('stub-card')).toHaveLength(2)
		expect(screen.getByText('b').parentElement).not.toHaveClass('hidden')
		expect(screen.getByText('a').parentElement).toHaveClass('hidden')

		act(() => {
			fireCommitSettled(itemQueueKeyImpl(queue[0]))
		})

		expect(screen.getAllByTestId('stub-card')).toHaveLength(1)
		expect(screen.getByTestId('stub-card')).toHaveTextContent('b')
	})

	it('keeps a pending-commit card mounted through the empty state when it was the last item in the queue', () => {
		const queue = [buildItem('a')]
		render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		act(() => {
			fireCommitScheduled(itemQueueKeyImpl(queue[0]))
			fireProcessed(itemQueueKeyImpl(queue[0]))
		})

		// The queue is empty (no current item), but the card whose commit is
		// still pending must stay mounted (hidden) rather than being torn down
		// by a root-element-type change between the empty and non-empty
		// render paths — that would cancel its still-running commit timer.
		expect(screen.getByText("You're caught up")).toBeInTheDocument()
		expect(screen.getByTestId('stub-card')).toHaveTextContent('a')
		expect(screen.getByTestId('stub-card').parentElement).toHaveClass('hidden')

		act(() => {
			fireCommitSettled(itemQueueKeyImpl(queue[0]))
		})

		expect(screen.queryByTestId('stub-card')).not.toBeInTheDocument()
	})

	it('drops a pending-commit card immediately on undo instead of waiting for onCommitSettled', () => {
		const queue = [buildItem('a'), buildItem('b')]
		render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		act(() => {
			fireCommitScheduled(itemQueueKeyImpl(queue[0]))
			fireProcessed(itemQueueKeyImpl(queue[0]))
		})
		expect(screen.getAllByTestId('stub-card')).toHaveLength(2)

		act(() => {
			fireRestored(itemQueueKeyImpl(queue[0]))
		})

		expect(screen.getAllByTestId('stub-card')).toHaveLength(1)
		expect(screen.getByTestId('stub-card')).toHaveTextContent('a')
	})

	it('"Keep unread" delegates to the current card\'s skip() via the imperative ref', () => {
		render(<ForYouCardQueue workspaceId="ws-1" queue={[buildItem('a')]} />)

		fireEvent.click(screen.getByRole('button', { name: 'Keep unread' }))

		expect(skipMock).toHaveBeenCalledTimes(1)
		expect(commitMock).not.toHaveBeenCalled()
	})

	it('"Mark as read" delegates to the current card\'s commit() via the imperative ref', () => {
		render(<ForYouCardQueue workspaceId="ws-1" queue={[buildItem('a')]} />)

		fireEvent.click(screen.getByRole('button', { name: 'Mark as read' }))

		expect(commitMock).toHaveBeenCalledTimes(1)
		expect(skipMock).not.toHaveBeenCalled()
	})

	it('falls back to the first visible item when the current key drops out of an updated queue', () => {
		const queue = [buildItem('a'), buildItem('b')]
		const { rerender } = render(<ForYouCardQueue workspaceId="ws-1" queue={queue} />)

		expect(screen.getByTestId('stub-card')).toHaveTextContent('a')

		// Simulate the item behind "a" being resolved elsewhere (e.g. another
		// actor marked it read) so it drops out of the live `queue` prop
		// entirely, without this container ever calling onProcessed itself.
		rerender(<ForYouCardQueue workspaceId="ws-1" queue={[buildItem('b')]} />)

		expect(screen.getByTestId('stub-card')).toHaveTextContent('b')
	})
})
