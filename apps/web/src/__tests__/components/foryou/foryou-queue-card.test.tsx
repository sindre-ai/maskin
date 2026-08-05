import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

// jsdom has no TransitionEvent constructor, so @testing-library/dom's
// fireEvent.transitionEnd() falls back to a plain Event and silently drops
// `propertyName` from the init — the handler's `e.propertyName !== 'transform'`
// guard then bails. Build the event by hand so the property survives dispatch.
function fireTransitionEnd(el: Element) {
	const event = new Event('transitionend', { bubbles: true })
	Object.assign(event, { propertyName: 'transform' })
	fireEvent(el, event)
}

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
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'viewer', name: 'Viewer', type: 'human', email: null }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: { id: 'other', name: 'Other', type: 'human' } }),
	useActors: () => ({
		data: [
			{ id: 'viewer', name: 'Viewer', type: 'human', isSystem: false },
			{ id: 'other', name: 'Other', type: 'human', isSystem: false },
		],
	}),
}))

import {
	ForYouQueueCard,
	type ForYouQueueCardHandle,
	itemQueueKey,
} from '@/components/foryou/foryou-queue-card'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 20,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({
			id: 'obj-1',
			title: 'Onboarding A/B',
			type: 'bet',
			status: 'active',
		}),
		...overrides,
	}
}

describe('ForYouQueueCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseEntityEvents.mockReturnValue({ data: [] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders the title, Open link, and the kind classified by classifyCardKind', () => {
		render(
			<ForYouQueueCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'Onboarding A/B',
						type: 'bet',
						status: 'in_review',
					}),
				})}
				onProcessed={vi.fn()}
				onRestored={vi.fn()}
				onCommitScheduled={vi.fn()}
				onCommitSettled={vi.fn()}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByText('Onboarding A/B')).toBeInTheDocument()
		expect(screen.getByTestId('foryou-queue-card')).toHaveAttribute('data-card-kind', 'decision')
		expect(screen.getByRole('link', { name: /open/i })).toBeInTheDocument()
	})

	it.each([
		['in_review', 'bet', 'decision'],
		['in_review', 'task', 'sign_off'],
		['proposed', 'bet', 'proposed_bet'],
		['active', 'insight', 'thread'],
	])('classifies status=%s type=%s as %s', (status, type, expectedKind) => {
		render(
			<ForYouQueueCard
				workspaceId="ws-1"
				item={buildItem({ object: buildObjectResponse({ id: 'obj-1', title: 'X', type, status }) })}
				onProcessed={vi.fn()}
				onRestored={vi.fn()}
				onCommitScheduled={vi.fn()}
				onCommitSettled={vi.fn()}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(screen.getByTestId('foryou-queue-card')).toHaveAttribute('data-card-kind', expectedKind)
	})

	it('emits foryou_card_shown once on mount, unconditional of visibility', () => {
		render(
			<ForYouQueueCard
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'Bet',
						type: 'bet',
						status: 'in_review',
					}),
				})}
				onProcessed={vi.fn()}
				onRestored={vi.fn()}
				onCommitScheduled={vi.fn()}
				onCommitSettled={vi.fn()}
			/>,
			{ wrapper: TestWrapper },
		)

		expect(trackForyouCardShownMock).toHaveBeenCalledTimes(1)
		expect(trackForyouCardShownMock).toHaveBeenCalledWith({
			card_kind: 'decision',
			card_id: 'obj-1',
		})
	})

	describe('decision → decided-receipt', () => {
		function renderDecisionCard(onProcessed = vi.fn(), onRestored = vi.fn()) {
			const item = buildItem({
				object: buildObjectResponse({
					id: 'obj-1',
					title: 'Bet',
					type: 'bet',
					status: 'in_review',
				}),
			})
			render(
				<ForYouQueueCard
					workspaceId="ws-1"
					item={item}
					onProcessed={onProcessed}
					onRestored={onRestored}
					onCommitScheduled={vi.fn()}
					onCommitSettled={vi.fn()}
				/>,
				{ wrapper: TestWrapper },
			)
			return item
		}

		it('clicking a decision option defers to a receipt with a live countdown, without posting the comment yet', () => {
			vi.useFakeTimers()
			renderDecisionCard()

			fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

			expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'decision',
				card_id: 'obj-1',
				action_id: 'approve',
			})
			const receipt = screen.getByTestId('decision-receipt')
			expect(receipt).toHaveTextContent('You chose Approve')
			expect(receipt).toHaveTextContent('Reversible for 6s')
			expect(mockCreateCommentMutate).not.toHaveBeenCalled()

			act(() => {
				vi.advanceTimersByTime(3000)
			})
			expect(screen.getByTestId('decision-receipt')).toHaveTextContent('Reversible for 3s')
		})

		it('"Reverse this" returns to the decision block and the comment is never posted', () => {
			vi.useFakeTimers()
			renderDecisionCard()

			fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
			act(() => {
				vi.advanceTimersByTime(3000)
			})
			fireEvent.click(screen.getByRole('button', { name: 'Reverse this' }))

			expect(screen.getByTestId('decision-block')).toBeInTheDocument()
			expect(screen.queryByTestId('decision-receipt')).not.toBeInTheDocument()

			// The cleared timer must not fire after the original deadline passes.
			act(() => {
				vi.advanceTimersByTime(10000)
			})
			expect(mockCreateCommentMutate).not.toHaveBeenCalled()
		})

		it('auto-commits once the reverse window elapses: posts the comment, marks read, and only advances after the exit transition ends', () => {
			vi.useFakeTimers()
			mockCreateCommentMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
			const onProcessed = vi.fn()
			const item = renderDecisionCard(onProcessed)

			fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
			act(() => {
				vi.advanceTimersByTime(6000)
			})

			expect(mockCreateCommentMutate).toHaveBeenCalledWith(
				{ entity_id: 'obj-1', content: 'Send back', parent_event_id: undefined },
				expect.any(Object),
			)
			expect(mockMarkReadMutate).toHaveBeenCalledWith({
				entityType: 'object',
				entityId: 'obj-1',
				lastEventId: 20,
			})

			const card = screen.getByTestId('foryou-queue-card')
			expect(card.style.transform).toBe('translateX(140%)')
			expect(onProcessed).not.toHaveBeenCalled()

			fireTransitionEnd(card)
			expect(onProcessed).toHaveBeenCalledWith(itemQueueKey(item))
		})
	})

	describe('quick-reply chips (non-decision kinds)', () => {
		it('sending a chip posts the comment and marks read, without exiting the card', () => {
			mockCreateCommentMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.())
			const item = buildItem({
				object: buildObjectResponse({
					id: 'obj-1',
					title: 'Thread item',
					type: 'insight',
					status: 'active',
				}),
			})
			render(
				<ForYouQueueCard
					workspaceId="ws-1"
					item={item}
					onProcessed={vi.fn()}
					onRestored={vi.fn()}
					onCommitScheduled={vi.fn()}
					onCommitSettled={vi.fn()}
				/>,
				{ wrapper: TestWrapper },
			)

			fireEvent.click(screen.getByRole('button', { name: 'On it' }))

			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'thread',
				card_id: 'obj-1',
				action_id: 'on_it',
			})
			expect(mockCreateCommentMutate).toHaveBeenCalledWith(
				{ entity_id: 'obj-1', content: 'On it', parent_event_id: undefined },
				expect.any(Object),
			)
			expect(mockMarkReadMutate).toHaveBeenCalledWith({
				entityType: 'object',
				entityId: 'obj-1',
				lastEventId: 20,
			})

			const card = screen.getByTestId('foryou-queue-card')
			expect(card.style.transform).toBe('translateX(0px)')
		})

		it('sign_off kind renders its own action chips instead of the decision block', () => {
			const item = buildItem({
				object: buildObjectResponse({
					id: 'obj-1',
					title: 'Task',
					type: 'task',
					status: 'in_review',
				}),
			})
			render(
				<ForYouQueueCard
					workspaceId="ws-1"
					item={item}
					onProcessed={vi.fn()}
					onRestored={vi.fn()}
					onCommitScheduled={vi.fn()}
					onCommitSettled={vi.fn()}
				/>,
				{ wrapper: TestWrapper },
			)

			expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Sign off' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Snooze 24h' })).toBeInTheDocument()
		})
	})

	describe('imperative handle', () => {
		it('skip() exits left immediately with no mutation, advancing only after the exit transition ends', () => {
			const onProcessed = vi.fn()
			const item = buildItem()
			const ref = createRef<ForYouQueueCardHandle>()
			render(
				<ForYouQueueCard
					ref={ref}
					workspaceId="ws-1"
					item={item}
					onProcessed={onProcessed}
					onRestored={vi.fn()}
					onCommitScheduled={vi.fn()}
					onCommitSettled={vi.fn()}
				/>,
				{ wrapper: TestWrapper },
			)

			act(() => {
				ref.current?.skip()
			})

			expect(trackForyouCardActionMock).toHaveBeenCalledWith({
				card_kind: 'thread',
				card_id: 'obj-1',
				action_id: 'keep_unread',
			})
			expect(mockMarkReadMutate).not.toHaveBeenCalled()
			expect(mockCreateCommentMutate).not.toHaveBeenCalled()

			const card = screen.getByTestId('foryou-queue-card')
			expect(card.style.transform).toBe('translateX(-140%)')
			expect(onProcessed).not.toHaveBeenCalled()

			fireTransitionEnd(card)
			expect(onProcessed).toHaveBeenCalledWith(itemQueueKey(item))
		})

		it('commit() drives the real swipe-to-mark-read commit path: exits immediately, marks read after the deferred window, advances only after the exit transition ends', () => {
			vi.useFakeTimers()
			const onProcessed = vi.fn()
			const item = buildItem()
			const ref = createRef<ForYouQueueCardHandle>()
			render(
				<ForYouQueueCard
					ref={ref}
					workspaceId="ws-1"
					item={item}
					onProcessed={onProcessed}
					onRestored={vi.fn()}
					onCommitScheduled={vi.fn()}
					onCommitSettled={vi.fn()}
				/>,
				{ wrapper: TestWrapper },
			)

			act(() => {
				ref.current?.commit()
			})

			const card = screen.getByTestId('foryou-queue-card')
			expect(card.style.transform).toBe('translateX(140%)')
			expect(mockMarkReadMutate).not.toHaveBeenCalled()

			act(() => {
				vi.advanceTimersByTime(4500)
			})
			expect(mockMarkReadMutate).toHaveBeenCalledWith({
				entityType: 'object',
				entityId: 'obj-1',
				lastEventId: 20,
			})

			expect(onProcessed).not.toHaveBeenCalled()
			fireTransitionEnd(card)
			expect(onProcessed).toHaveBeenCalledWith(itemQueueKey(item))
		})
	})
})
