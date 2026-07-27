import { act, renderHook } from '@testing-library/react'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: vi.fn(),
}))

vi.mock('@/lib/analytics', () => ({
	trackForyouCardMarkedRead: vi.fn(),
}))

import { useSwipeToMarkRead } from '@/hooks/use-swipe-to-mark-read'
import { trackForyouCardMarkedRead } from '@/lib/analytics'

describe('useSwipeToMarkRead', () => {
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

		// Simulate a completed right-swipe past the threshold.
		act(() => {
			result.current.handlePointerDown({
				clientX: 0,
				clientY: 0,
				pointerId: 1,
				currentTarget: {},
				target: document.createElement('div'),
				preventDefault: () => {},
			} as never)
			result.current.handlePointerMove({
				clientX: 120,
				clientY: 0,
				preventDefault: () => {},
			} as never)
			result.current.handlePointerUp()
		})

		expect(trackForyouCardMarkedRead).not.toHaveBeenCalled()
		expect(onMarkRead).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(4500)
		})

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

		act(() => {
			result.current.handlePointerDown({
				clientX: 0,
				clientY: 0,
				pointerId: 1,
				currentTarget: {},
				target: document.createElement('div'),
				preventDefault: () => {},
			} as never)
			result.current.handlePointerMove({
				clientX: 120,
				clientY: 0,
				preventDefault: () => {},
			} as never)
			result.current.handlePointerUp()
		})

		// Simulate the Undo action passed to sonner's toast.
		const toastCall = vi.mocked(toast).mock.calls[0]
		expect(toastCall).toBeDefined()
		const opts = toastCall?.[1] as { action?: { onClick: () => void } }
		expect(opts?.action?.onClick).toBeTypeOf('function')
		act(() => {
			opts.action?.onClick()
		})

		act(() => {
			vi.advanceTimersByTime(4500)
		})

		expect(onMarkRead).not.toHaveBeenCalled()
		expect(trackForyouCardMarkedRead).not.toHaveBeenCalled()
	})

	it('does not emit when analytics context is omitted (back-compat with existing callers)', () => {
		const onMarkRead = vi.fn()
		const { result } = renderHook(() => useSwipeToMarkRead(onMarkRead))

		act(() => {
			result.current.handlePointerDown({
				clientX: 0,
				clientY: 0,
				pointerId: 1,
				currentTarget: {},
				target: document.createElement('div'),
				preventDefault: () => {},
			} as never)
			result.current.handlePointerMove({
				clientX: 120,
				clientY: 0,
				preventDefault: () => {},
			} as never)
			result.current.handlePointerUp()
		})

		act(() => {
			vi.advanceTimersByTime(4500)
		})

		expect(onMarkRead).toHaveBeenCalledTimes(1)
		expect(trackForyouCardMarkedRead).not.toHaveBeenCalled()
	})
})
