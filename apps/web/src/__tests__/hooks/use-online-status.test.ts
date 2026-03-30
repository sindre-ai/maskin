import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useOnlineStatus } from '@/hooks/use-online-status'

let listeners: Record<string, Set<() => void>> = {}

beforeEach(() => {
	vi.clearAllMocks()
	listeners = {}

	vi.spyOn(window, 'addEventListener').mockImplementation(
		(event: string, handler: EventListenerOrEventListenerObject | null) => {
			if (!listeners[event]) listeners[event] = new Set()
			listeners[event].add(handler as () => void)
		},
	)

	vi.spyOn(window, 'removeEventListener').mockImplementation(
		(event: string, handler: EventListenerOrEventListenerObject | null) => {
			listeners[event]?.delete(handler as () => void)
		},
	)
})

afterEach(() => {
	vi.restoreAllMocks()
})

function fireEvent(event: string) {
	if (listeners[event]) {
		for (const handler of listeners[event]) {
			handler()
		}
	}
}

describe('useOnlineStatus', () => {
	it('returns true when navigator.onLine is true', () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

		const { result } = renderHook(() => useOnlineStatus())

		expect(result.current).toBe(true)
	})

	it('returns false when navigator.onLine is false', () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

		const { result } = renderHook(() => useOnlineStatus())

		expect(result.current).toBe(false)
	})

	it('updates to false on offline window event', () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

		const { result } = renderHook(() => useOnlineStatus())
		expect(result.current).toBe(true)

		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
		act(() => {
			fireEvent('offline')
		})

		expect(result.current).toBe(false)
	})

	it('updates to true on online window event', () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

		const { result } = renderHook(() => useOnlineStatus())
		expect(result.current).toBe(false)

		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
		act(() => {
			fireEvent('online')
		})

		expect(result.current).toBe(true)
	})

	it('cleans up listeners on unmount', () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

		const { unmount } = renderHook(() => useOnlineStatus())

		expect(listeners.online?.size).toBe(1)
		expect(listeners.offline?.size).toBe(1)

		unmount()

		expect(listeners.online?.size).toBe(0)
		expect(listeners.offline?.size).toBe(0)
	})
})
