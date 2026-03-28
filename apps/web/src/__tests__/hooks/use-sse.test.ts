import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAbort = vi.fn()
const mockConnectSSE = vi.fn((_workspaceId: string, _callbacks: unknown) => ({
	abort: mockAbort,
	signal: {},
}))

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
})

describe('useSSE', () => {
	it('returns connecting as initial status', () => {
		const { result } = renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
		expect(result.current).toBe('connecting')
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
		expect(mockAbort).toHaveBeenCalled()
	})

	it('reconnects when workspaceId changes', () => {
		const { rerender } = renderHook(({ wsId }) => useSSE(wsId), {
			wrapper: TestWrapper,
			initialProps: { wsId: 'ws-1' },
		})

		expect(mockConnectSSE).toHaveBeenCalledTimes(1)

		rerender({ wsId: 'ws-2' })

		// Should have aborted the first connection and created a new one
		expect(mockAbort).toHaveBeenCalled()
		expect(mockConnectSSE).toHaveBeenCalledTimes(2)
		expect(mockConnectSSE).toHaveBeenLastCalledWith('ws-2', expect.any(Object))
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
})
