import { useMarkNewestRead } from '@/hooks/use-mark-newest-read'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('useMarkNewestRead', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('marks the newest id once', async () => {
		const markRead = vi.fn().mockResolvedValue(undefined)
		const { rerender } = renderHook(({ id }) => useMarkNewestRead(id, markRead), {
			initialProps: { id: 5 as number | null },
		})
		await act(async () => {})
		rerender({ id: 5 })
		await act(async () => {})
		expect(markRead).toHaveBeenCalledTimes(1)
		expect(markRead).toHaveBeenCalledWith(5)
	})

	it('retries the same id after a failed call until it succeeds', async () => {
		const markRead = vi
			.fn()
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValue(undefined)
		renderHook(() => useMarkNewestRead(7, markRead))
		await act(async () => {})
		expect(markRead).toHaveBeenCalledTimes(1)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000)
		})
		expect(markRead).toHaveBeenCalledTimes(2)
		expect(markRead).toHaveBeenLastCalledWith(7)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000)
		})
		expect(markRead).toHaveBeenCalledTimes(2)
	})

	it('marks a newer message straight away', async () => {
		const markRead = vi.fn().mockResolvedValue(undefined)
		const { rerender } = renderHook(({ id }) => useMarkNewestRead(id, markRead), {
			initialProps: { id: 5 as number | null },
		})
		await act(async () => {})
		rerender({ id: 6 })
		await act(async () => {})
		expect(markRead).toHaveBeenNthCalledWith(2, 6)
	})

	it('does nothing when there is nothing to mark', async () => {
		const markRead = vi.fn().mockResolvedValue(undefined)
		renderHook(() => useMarkNewestRead(null, markRead))
		await act(async () => {})
		expect(markRead).not.toHaveBeenCalled()
	})
})
