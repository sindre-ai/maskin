import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/format-duration', () => ({
	formatDurationMs: vi.fn(),
}))

import { formatDurationMs } from '@/lib/format-duration'
import { useDuration } from '@/hooks/use-duration'

beforeEach(() => {
	vi.useFakeTimers()
	vi.clearAllMocks()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('useDuration', () => {
	it('returns null when startedAt is null', () => {
		const { result } = renderHook(() => useDuration(null))
		expect(result.current).toBeNull()
		expect(formatDurationMs).not.toHaveBeenCalled()
	})

	it('returns null when startedAt is undefined', () => {
		const { result } = renderHook(() => useDuration(undefined))
		expect(result.current).toBeNull()
		expect(formatDurationMs).not.toHaveBeenCalled()
	})

	it('returns formatted duration string when startedAt is provided', () => {
		vi.mocked(formatDurationMs).mockReturnValue('5m 30s')
		const startedAt = new Date(Date.now() - 330000).toISOString()

		const { result } = renderHook(() => useDuration(startedAt))

		expect(result.current).toBe('5m 30s')
		expect(formatDurationMs).toHaveBeenCalled()
	})

	it('updates on 30s interval tick', () => {
		vi.mocked(formatDurationMs).mockReturnValue('1m 0s')

		const startedAt = new Date(Date.now() - 60000).toISOString()
		const { result } = renderHook(() => useDuration(startedAt))

		expect(result.current).toBe('1m 0s')
		const callsBefore = vi.mocked(formatDurationMs).mock.calls.length

		vi.mocked(formatDurationMs).mockReturnValue('1m 30s')
		act(() => {
			vi.advanceTimersByTime(30000)
		})

		expect(result.current).toBe('1m 30s')
		expect(vi.mocked(formatDurationMs).mock.calls.length).toBeGreaterThan(callsBefore)
	})

	it('cleans up interval on unmount', () => {
		vi.mocked(formatDurationMs).mockReturnValue('0s')
		const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
		const startedAt = new Date(Date.now() - 1000).toISOString()

		const { unmount } = renderHook(() => useDuration(startedAt))
		unmount()

		expect(clearIntervalSpy).toHaveBeenCalled()
		clearIntervalSpy.mockRestore()
	})
})
