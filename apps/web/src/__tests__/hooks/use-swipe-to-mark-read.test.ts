import { act, renderHook } from '@testing-library/react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: vi.fn(),
}))

vi.mock('@/lib/analytics', () => ({
	trackForyouCardMarkedRead: vi.fn(),
	trackForyouCardMarkedUnread: vi.fn(),
}))

import { SWIPE_THRESHOLD, useSwipeToMarkRead } from '@/hooks/use-swipe-to-mark-read'
import { trackForyouCardMarkedRead, trackForyouCardMarkedUnread } from '@/lib/analytics'

// Minimal synthetic pointer event — jsdom doesn't give us real PointerEvent
// synthesis and the hook only reads clientX/clientY/pointerId/target and calls
// preventDefault + setPointerCapture. This shape matches everything the hook
// touches without pulling in the full React SyntheticEvent contract.
function pointerEvent(
	clientX: number,
	clientY = 0,
	target: HTMLElement | null = null,
): ReactPointerEvent<HTMLDivElement> {
	const el = document.createElement('div')
	return {
		clientX,
		clientY,
		pointerId: 1,
		currentTarget: el,
		target: target ?? el,
		preventDefault: () => {},
	} as unknown as ReactPointerEvent<HTMLDivElement>
}

describe('useSwipeToMarkRead — analytics contract', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	// The DoD requires the PostHog event to fire on a *completed* swipe — i.e.
	// only after the 4.5s Undo window expires. Firing on gesture end would double-
	// count swipes that the user reverses with Undo, biasing the ship metric.
	it('emits foryou_card_marked_read after the 4.5s Undo window expires when analytics context is provided', () => {
		const onMarkRead = vi.fn()
		const { result } = renderHook(() =>
			useSwipeToMarkRead(onMarkRead, { entity_type: 'bet', entity_id: 'bet-42' }),
		)

		act(() => result.current.handlePointerDown(pointerEvent(0)))
		act(() => result.current.handlePointerMove(pointerEvent(120)))
		act(() => result.current.handlePointerUp())

		expect(trackForyouCardMarkedRead).not.toHaveBeenCalled()
		expect(onMarkRead).not.toHaveBeenCalled()

		act(() => vi.advanceTimersByTime(4500))

		expect(onMarkRead).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedRead).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedRead).toHaveBeenCalledWith({
			entity_type: 'bet',
			entity_id: 'bet-42',
		})
	})

	it('does not emit foryou_card_marked_read when the user taps Undo inside the 4.5s window', () => {
		const onMarkRead = vi.fn()
		const { result } = renderHook(() =>
			useSwipeToMarkRead(onMarkRead, { entity_type: 'bet', entity_id: 'bet-42' }),
		)

		act(() => result.current.handlePointerDown(pointerEvent(0)))
		act(() => result.current.handlePointerMove(pointerEvent(120)))
		act(() => result.current.handlePointerUp())

		const toastCall = vi.mocked(toast).mock.calls[0]
		expect(toastCall).toBeDefined()
		const opts = toastCall?.[1] as { action?: { onClick: () => void } }
		expect(opts?.action?.onClick).toBeTypeOf('function')
		act(() => opts.action?.onClick())

		act(() => vi.advanceTimersByTime(4500))

		expect(onMarkRead).not.toHaveBeenCalled()
		expect(trackForyouCardMarkedRead).not.toHaveBeenCalled()
	})

	it('does not emit when analytics context is omitted (back-compat with existing callers)', () => {
		const onMarkRead = vi.fn()
		const { result } = renderHook(() => useSwipeToMarkRead(onMarkRead))

		act(() => result.current.handlePointerDown(pointerEvent(0)))
		act(() => result.current.handlePointerMove(pointerEvent(120)))
		act(() => result.current.handlePointerUp())

		act(() => vi.advanceTimersByTime(4500))

		expect(onMarkRead).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedRead).not.toHaveBeenCalled()
	})

	// Reverse-swipe emission. Fires only after the 4.5s Undo commit — Undo
	// suppresses it, and analytics context is required to emit at all.
	it('emits foryou_card_marked_unread after the 4.5s Undo window expires on a read-card left-swipe', () => {
		const onMarkUnread = vi.fn()
		const { result } = renderHook(() =>
			useSwipeToMarkRead({
				onMarkRead: vi.fn(),
				onMarkUnread,
				isRead: true,
				analytics: { entity_type: 'bet', entity_id: 'bet-99' },
			}),
		)

		act(() => result.current.handlePointerDown(pointerEvent(0)))
		act(() => result.current.handlePointerMove(pointerEvent(-120)))
		act(() => result.current.handlePointerUp())

		expect(trackForyouCardMarkedUnread).not.toHaveBeenCalled()
		expect(onMarkUnread).not.toHaveBeenCalled()

		act(() => vi.advanceTimersByTime(4500))

		expect(onMarkUnread).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedUnread).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedUnread).toHaveBeenCalledWith({
			entity_type: 'bet',
			entity_id: 'bet-99',
		})
	})

	it('Undo on a mark-unread swipe suppresses both the mutation and the analytics event', () => {
		const onMarkUnread = vi.fn()
		const { result } = renderHook(() =>
			useSwipeToMarkRead({
				onMarkRead: vi.fn(),
				onMarkUnread,
				isRead: true,
				analytics: { entity_type: 'bet', entity_id: 'bet-99' },
			}),
		)

		act(() => result.current.handlePointerDown(pointerEvent(0)))
		act(() => result.current.handlePointerMove(pointerEvent(-120)))
		act(() => result.current.handlePointerUp())

		const opts = vi.mocked(toast).mock.calls[0]?.[1] as { action?: { onClick: () => void } }
		act(() => opts.action?.onClick())
		act(() => vi.advanceTimersByTime(4500))

		expect(onMarkUnread).not.toHaveBeenCalled()
		expect(trackForyouCardMarkedUnread).not.toHaveBeenCalled()
	})
})

describe('useSwipeToMarkRead — bidirectional gesture', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	describe('unread card (isRead = false)', () => {
		it('fires onMarkRead 4.5s after a right-swipe past threshold', () => {
			const onMarkRead = vi.fn()
			const onMarkUnread = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead, onMarkUnread, isRead: false }),
			)

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(100)))
			act(() => result.current.handlePointerUp())

			expect(result.current.swipePending).toBe(true)
			expect(toast).toHaveBeenCalledWith('Marked as read', expect.any(Object))
			expect(onMarkRead).not.toHaveBeenCalled()

			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkRead).toHaveBeenCalledTimes(1)
			expect(onMarkUnread).not.toHaveBeenCalled()
		})

		it('fires onSwipeLeft after a left-swipe past threshold (keep-unread gesture)', () => {
			const onMarkRead = vi.fn()
			const onSwipeLeft = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead, isRead: false, onSwipeLeft }),
			)

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(-150)))

			expect(result.current.dragOffset).toBe(-150)

			act(() => result.current.handlePointerUp())

			expect(onSwipeLeft).toHaveBeenCalledTimes(1)
			expect(onMarkRead).not.toHaveBeenCalled()
			expect(toast).not.toHaveBeenCalled()
		})

		it('does not fire onSwipeLeft when the left-drag stays under threshold', () => {
			const onSwipeLeft = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead: vi.fn(), isRead: false, onSwipeLeft }),
			)

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(-30)))
			act(() => result.current.handlePointerUp())

			expect(onSwipeLeft).not.toHaveBeenCalled()
		})
	})

	describe('read card (isRead = true)', () => {
		it('fires onMarkUnread 4.5s after a left-swipe past threshold', () => {
			const onMarkRead = vi.fn()
			const onMarkUnread = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead, onMarkUnread, isRead: true }),
			)

			expect(result.current.revealVariant).toBe('mark-unread')

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(-100)))
			act(() => result.current.handlePointerUp())

			expect(result.current.swipePending).toBe(true)
			expect(toast).toHaveBeenCalledWith('Marked as unread', expect.any(Object))

			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkUnread).toHaveBeenCalledTimes(1)
			expect(onMarkRead).not.toHaveBeenCalled()
		})

		it('fires onMarkUnread on velocity flick above threshold even when displacement < 80px', () => {
			const onMarkUnread = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead: vi.fn(), onMarkUnread, isRead: true }),
			)

			// Fake a fast leftward flick: 40px in ~50ms → velocity ≈ 0.8 px/ms
			// (well past the 0.42 px/ms VELOCITY_THRESHOLD).
			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => {
				vi.advanceTimersByTime(50)
				result.current.handlePointerMove(pointerEvent(-40))
			})
			act(() => result.current.handlePointerUp())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkUnread).toHaveBeenCalledTimes(1)
		})

		it('clamps right-drag to zero displacement (wrong-direction bounce)', () => {
			const onMarkRead = vi.fn()
			const onMarkUnread = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead, onMarkUnread, isRead: true }),
			)

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(150)))

			expect(result.current.dragOffset).toBe(0)
			expect(result.current.swipeBgOpacity).toBe(0)

			act(() => result.current.handlePointerUp())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkRead).not.toHaveBeenCalled()
			expect(onMarkUnread).not.toHaveBeenCalled()
			expect(toast).not.toHaveBeenCalled()
		})

		it('does not fire onMarkUnread when the swipe is slow and under the threshold', () => {
			const onMarkUnread = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead: vi.fn(), onMarkUnread, isRead: true }),
			)

			// -30px stretched over 500ms → velocity ≈ 0.06 px/ms (well below the
			// 0.42 px/ms floor) and displacement well under the 80px threshold.
			// Nothing should commit; the card rubber-bands back.
			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => {
				vi.advanceTimersByTime(500)
				result.current.handlePointerMove(pointerEvent(-30))
			})
			act(() => result.current.handlePointerUp())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkUnread).not.toHaveBeenCalled()
			expect(result.current.dragOffset).toBe(0)
		})
	})

	describe('Undo cancels the pending timer', () => {
		it('cancels mark-read when Undo is invoked before the 4.5s window', () => {
			const onMarkRead = vi.fn()
			const { result } = renderHook(() => useSwipeToMarkRead({ onMarkRead, isRead: false }))

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(100)))
			act(() => result.current.handlePointerUp())

			const toastCall = vi.mocked(toast).mock.calls.at(-1)
			expect(toastCall?.[0]).toBe('Marked as read')
			const undo = (toastCall?.[1] as { action?: { onClick: () => void } })?.action?.onClick
			expect(typeof undo).toBe('function')

			act(() => undo?.())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkRead).not.toHaveBeenCalled()
		})

		it('cancels mark-unread when Undo is invoked before the 4.5s window', () => {
			const onMarkUnread = vi.fn()
			const { result } = renderHook(() =>
				useSwipeToMarkRead({ onMarkRead: vi.fn(), onMarkUnread, isRead: true }),
			)

			act(() => result.current.handlePointerDown(pointerEvent(0)))
			act(() => result.current.handlePointerMove(pointerEvent(-100)))
			act(() => result.current.handlePointerUp())

			const undo = (
				vi.mocked(toast).mock.calls.at(-1)?.[1] as {
					action?: { onClick: () => void }
				}
			)?.action?.onClick
			act(() => undo?.())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkUnread).not.toHaveBeenCalled()
		})
	})

	describe('form control exclusion', () => {
		// A press starting inside the composer's textarea must not engage the
		// swipe gesture — setPointerCapture on the card would otherwise retarget
		// the pointer and break iOS Safari's native tap-to-focus, requiring a
		// second tap before the user can type.
		it('ignores pointerdown on a textarea and never engages the drag', () => {
			const onMarkRead = vi.fn()
			const { result } = renderHook(() => useSwipeToMarkRead(onMarkRead))
			const textarea = document.createElement('textarea')

			act(() => result.current.handlePointerDown(pointerEvent(0, 0, textarea)))
			expect(result.current.isDragging).toBe(false)

			act(() => result.current.handlePointerMove(pointerEvent(SWIPE_THRESHOLD + 10)))
			act(() => result.current.handlePointerUp())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkRead).not.toHaveBeenCalled()
		})

		it('ignores pointerdown on an input and never engages the drag', () => {
			const onMarkRead = vi.fn()
			const { result } = renderHook(() => useSwipeToMarkRead(onMarkRead))
			const input = document.createElement('input')

			act(() => result.current.handlePointerDown(pointerEvent(0, 0, input)))
			expect(result.current.isDragging).toBe(false)

			act(() => result.current.handlePointerMove(pointerEvent(SWIPE_THRESHOLD + 10)))
			act(() => result.current.handlePointerUp())
			act(() => vi.advanceTimersByTime(4500))

			expect(onMarkRead).not.toHaveBeenCalled()
		})

		it('still engages the drag for presses outside form controls', () => {
			const onMarkRead = vi.fn()
			const { result } = renderHook(() => useSwipeToMarkRead(onMarkRead))
			const card = document.createElement('div')

			act(() => result.current.handlePointerDown(pointerEvent(0, 0, card)))
			expect(result.current.isDragging).toBe(true)
		})
	})

	it('legacy positional-callback signature still fires onMarkRead on right-swipe', () => {
		// Callsites that only need mark-read (no reverse gesture) may still pass
		// a bare callback — proves nothing regresses when the mark-unread path
		// is not wired up.
		const onMarkRead = vi.fn()
		const { result } = renderHook(() => useSwipeToMarkRead(onMarkRead))

		act(() => result.current.handlePointerDown(pointerEvent(0)))
		act(() => result.current.handlePointerMove(pointerEvent(SWIPE_THRESHOLD + 10)))
		act(() => result.current.handlePointerUp())
		act(() => vi.advanceTimersByTime(4500))

		expect(onMarkRead).toHaveBeenCalledTimes(1)
	})
})
