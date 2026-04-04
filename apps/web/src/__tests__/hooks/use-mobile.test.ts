import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useIsMobile } from '@/hooks/use-mobile'

let changeHandler: (() => void) | null = null
const mockAddEventListener = vi.fn((event: string, handler: () => void) => {
	if (event === 'change') changeHandler = handler
})
const mockRemoveEventListener = vi.fn()

function setupMatchMedia(matches: boolean) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: vi.fn().mockReturnValue({
			matches,
			addEventListener: mockAddEventListener,
			removeEventListener: mockRemoveEventListener,
		}),
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	changeHandler = null
})

describe('useIsMobile', () => {
	it('returns false when width >= 768px', () => {
		setupMatchMedia(false)
		Object.defineProperty(window, 'innerWidth', { writable: true, value: 1024 })

		const { result } = renderHook(() => useIsMobile())

		expect(result.current).toBe(false)
	})

	it('returns true when width < 768px', () => {
		setupMatchMedia(true)
		Object.defineProperty(window, 'innerWidth', { writable: true, value: 500 })

		const { result } = renderHook(() => useIsMobile())

		expect(result.current).toBe(true)
	})

	it('updates when media query change event fires', () => {
		setupMatchMedia(false)
		Object.defineProperty(window, 'innerWidth', { writable: true, value: 1024 })

		const { result } = renderHook(() => useIsMobile())
		expect(result.current).toBe(false)

		// Simulate resize to mobile
		Object.defineProperty(window, 'innerWidth', { writable: true, value: 500 })
		act(() => {
			changeHandler?.()
		})

		expect(result.current).toBe(true)
	})

	it('cleans up event listener on unmount', () => {
		setupMatchMedia(false)
		Object.defineProperty(window, 'innerWidth', { writable: true, value: 1024 })

		const { unmount } = renderHook(() => useIsMobile())
		unmount()

		expect(mockRemoveEventListener).toHaveBeenCalledWith('change', expect.any(Function))
	})
})
