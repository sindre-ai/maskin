import { UNDO_SEND_WINDOW_MS, useUndoSend } from '@/hooks/use-undo-send'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const flag = vi.hoisted(() => ({ on: true }))
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))

function held(send = vi.fn().mockResolvedValue(undefined)) {
	return {
		send,
		sendOnHide: vi.fn().mockResolvedValue(undefined),
		restore: vi.fn(),
		onError: vi.fn(),
	}
}

describe('useUndoSend', () => {
	beforeEach(() => {
		flag.on = true
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('posts nothing until the window ends', async () => {
		const { result } = renderHook(() => useUndoSend())
		const m = held()
		await act(() => result.current.hold(m))
		expect(result.current.isHeld).toBe(true)

		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS - 1))
		expect(m.send).not.toHaveBeenCalled()

		await act(() => vi.advanceTimersByTimeAsync(1))
		expect(m.send).toHaveBeenCalledTimes(1)
		expect(result.current.isHeld).toBe(false)
	})

	it('undo restores the message and never posts it', async () => {
		const { result } = renderHook(() => useUndoSend())
		const m = held()
		await act(() => result.current.hold(m))

		act(() => result.current.undo())
		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS * 2))

		expect(m.restore).toHaveBeenCalledTimes(1)
		expect(m.send).not.toHaveBeenCalled()
		expect(result.current.isHeld).toBe(false)
	})

	it('posts the held message first, in order, when another is sent', async () => {
		const { result } = renderHook(() => useUndoSend())
		const order: string[] = []
		const first = held(vi.fn(async () => void order.push('first')))
		const second = held(vi.fn(async () => void order.push('second')))

		await act(() => result.current.hold(first))
		await act(() => result.current.hold(second))
		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS))

		expect(order).toEqual(['first', 'second'])
	})

	it('posts the held message when the owner goes away', async () => {
		const { result, unmount } = renderHook(() => useUndoSend())
		const m = held()
		await act(() => result.current.hold(m))

		await act(async () => unmount())

		expect(m.send).toHaveBeenCalledTimes(1)
	})

	it('sends the held message at once, outliving the page, when the tab closes', async () => {
		const { result } = renderHook(() => useUndoSend())
		const m = held()
		await act(() => result.current.hold(m))

		act(() => {
			window.dispatchEvent(new Event('pagehide'))
		})

		expect(m.sendOnHide).toHaveBeenCalledTimes(1)
		expect(m.send).not.toHaveBeenCalled()
		expect(result.current.isHeld).toBe(false)
		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS * 2))
		expect(m.send).not.toHaveBeenCalled()
	})

	it('sends the held message at once when the app goes to the background', async () => {
		const { result } = renderHook(() => useUndoSend())
		const m = held()
		await act(() => result.current.hold(m))

		const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'))
		})
		state.mockRestore()

		expect(m.sendOnHide).toHaveBeenCalledTimes(1)
	})

	it('posts the held message when the scope changes', async () => {
		const { result, rerender } = renderHook(({ scope }) => useUndoSend(scope), {
			initialProps: { scope: 'a' },
		})
		const m = held()
		await act(() => result.current.hold(m))

		await act(async () => rerender({ scope: 'b' }))

		expect(m.send).toHaveBeenCalledTimes(1)
	})

	it('restores the message and reports the error when a delayed send fails', async () => {
		const { result } = renderHook(() => useUndoSend())
		const boom = new Error('nope')
		const m = held(vi.fn().mockRejectedValue(boom))
		await act(() => result.current.hold(m))

		await act(() => vi.advanceTimersByTimeAsync(UNDO_SEND_WINDOW_MS))

		expect(m.restore).toHaveBeenCalledTimes(1)
		expect(m.onError).toHaveBeenCalledWith(boom)
	})

	it('with the flag off sends at once and lets a failure reach the caller', async () => {
		flag.on = false
		const { result } = renderHook(() => useUndoSend())
		const ok = held()
		await act(() => result.current.hold(ok))
		expect(ok.send).toHaveBeenCalledTimes(1)
		expect(result.current.isHeld).toBe(false)

		const failing = held(vi.fn().mockRejectedValue(new Error('nope')))
		await expect(result.current.hold(failing)).rejects.toThrow('nope')
		expect(failing.restore).not.toHaveBeenCalled()
	})
})
