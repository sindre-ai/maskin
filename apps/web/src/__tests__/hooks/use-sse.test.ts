import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockController: AbortController
const mockConnectSSE = vi.fn((_workspaceId: string, _callbacks: unknown) => {
	mockController = new AbortController()
	return mockController
})

vi.mock('@/lib/sse', () => ({
	connectSSE: (workspaceId: string, callbacks: unknown) => mockConnectSSE(workspaceId, callbacks),
}))

vi.mock('@/lib/sse-invalidation', () => ({
	invalidateFromSSE: vi.fn(),
}))

import { useSSE } from '@/hooks/use-sse'
import { invalidateFromSSE } from '@/lib/sse-invalidation'
import { TestWrapper } from '../setup'

beforeEach(() => {
	vi.clearAllMocks()
	setVisibility('visible')
})

afterEach(() => {
	setVisibility('visible')
})

function setVisibility(state: 'visible' | 'hidden') {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		value: state,
	})
}

function dispatchVisibilityChange() {
	act(() => {
		document.dispatchEvent(new Event('visibilitychange'))
	})
}

describe('useSSE', () => {
	it('returns connecting as initial status', () => {
		const { result } = renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
		expect(result.current).toBe('connecting')
	})

	it('updates status when onStatusChange is called', async () => {
		const { result } = renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
		expect(result.current).toBe('connecting')

		const callbacks = mockConnectSSE.mock.calls[0][1] as {
			onStatusChange: (status: string) => void
		}
		act(() => callbacks.onStatusChange('connected'))
		expect(result.current).toBe('connected')

		act(() => callbacks.onStatusChange('disconnected'))
		expect(result.current).toBe('disconnected')
	})

	it('calls connectSSE with workspaceId and callbacks', () => {
		renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })

		expect(mockConnectSSE).toHaveBeenCalledWith('ws-1', {
			onEvent: expect.any(Function),
			onStatusChange: expect.any(Function),
		})
	})

	it('does not connect when workspaceId is empty', () => {
		renderHook(() => useSSE(''), { wrapper: TestWrapper })
		expect(mockConnectSSE).not.toHaveBeenCalled()
	})

	it('aborts controller on unmount', () => {
		const { unmount } = renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
		unmount()
		expect(mockController.signal.aborted).toBe(true)
	})

	it('reconnects when workspaceId changes', () => {
		const { result, rerender } = renderHook(({ wsId }) => useSSE(wsId), {
			wrapper: TestWrapper,
			initialProps: { wsId: 'ws-1' },
		})

		expect(mockConnectSSE).toHaveBeenCalledTimes(1)

		// Simulate connected status on first connection
		const callbacks = mockConnectSSE.mock.calls[0][1] as {
			onStatusChange: (status: string) => void
		}
		act(() => callbacks.onStatusChange('connected'))
		expect(result.current).toBe('connected')

		const firstController = mockController
		rerender({ wsId: 'ws-2' })

		// Should have aborted the first connection and created a new one
		expect(firstController.signal.aborted).toBe(true)
		expect(mockConnectSSE).toHaveBeenCalledTimes(2)
		expect(mockConnectSSE).toHaveBeenLastCalledWith('ws-2', expect.any(Object))
		// Status should reset to connecting
		expect(result.current).toBe('connecting')
	})

	it('calls invalidateFromSSE when an event is received', () => {
		renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })

		const callbacks = mockConnectSSE.mock.calls[0][1] as {
			onEvent: (event: unknown) => void
		}
		const event = { entity_type: 'object', entity_id: 'obj-1', action: 'created' }
		callbacks.onEvent(event)

		expect(invalidateFromSSE).toHaveBeenCalledWith(expect.anything(), 'ws-1', event)
	})

	describe('foreground resume (background → foreground)', () => {
		it('reconnects (aborts and re-establishes) when the document returns to visible', () => {
			const { result } = renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
			expect(mockConnectSSE).toHaveBeenCalledTimes(1)
			const firstController = mockController

			setVisibility('hidden')
			dispatchVisibilityChange()
			expect(mockConnectSSE).toHaveBeenCalledTimes(1) // no reconnect while hidden

			setVisibility('visible')
			dispatchVisibilityChange()

			// The fresh connectSSE re-reads the persisted Last-Event-ID, so the
			// server replays anything missed while the app was backgrounded.
			expect(firstController.signal.aborted).toBe(true)
			expect(mockConnectSSE).toHaveBeenCalledTimes(2)
			expect(mockConnectSSE).toHaveBeenLastCalledWith('ws-1', expect.any(Object))
			expect(result.current).toBe('connecting')
		})

		it('reconnects on each background→foreground cycle, never getting stuck', () => {
			const { result } = renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
			expect(mockConnectSSE).toHaveBeenCalledTimes(1)

			setVisibility('hidden')
			dispatchVisibilityChange()
			setVisibility('visible')
			dispatchVisibilityChange()
			expect(mockConnectSSE).toHaveBeenCalledTimes(2)

			const secondController = mockController
			setVisibility('hidden')
			dispatchVisibilityChange()
			setVisibility('visible')
			dispatchVisibilityChange()
			expect(secondController.signal.aborted).toBe(true)
			expect(mockConnectSSE).toHaveBeenCalledTimes(3)
			expect(result.current).toBe('connecting')
		})

		it('does not reconnect on foreground when there is no active workspace', () => {
			renderHook(() => useSSE(''), { wrapper: TestWrapper })
			expect(mockConnectSSE).not.toHaveBeenCalled()

			setVisibility('visible')
			dispatchVisibilityChange()
			expect(mockConnectSSE).not.toHaveBeenCalled()
		})
	})
})
