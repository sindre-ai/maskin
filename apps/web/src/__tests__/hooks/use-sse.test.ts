import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
})

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
			onReconnect: expect.any(Function),
			onError: expect.any(Function),
		})
	})

	it('resyncs caches when the stream reconnects', () => {
		const invalidateQueries = vi.spyOn(QueryClient.prototype, 'invalidateQueries')

		renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })

		const callbacks = mockConnectSSE.mock.calls[0]?.[1] as { onReconnect?: () => void } | undefined
		callbacks?.onReconnect?.()

		// Server-side replay is capped at 100 events, so anything cached during
		// the disconnect may be stale — without this the chat transcript stays
		// frozen after a dropped connection until the user reloads.
		expect(invalidateQueries).toHaveBeenCalled()
	})

	it('collapses a burst of reconnects into one resync', () => {
		vi.useFakeTimers()
		try {
			const invalidateQueries = vi.spyOn(QueryClient.prototype, 'invalidateQueries')
			invalidateQueries.mockClear()

			renderHook(() => useSSE('ws-1'), { wrapper: TestWrapper })
			const callbacks = mockConnectSSE.mock.calls[0]?.[1] as
				| { onReconnect?: () => void }
				| undefined

			// fetch-event-source re-runs onopen on every internal retry, so a
			// flapping backend fires this once a second. Unthrottled that is a
			// full-cache refetch per second, in exactly the degraded conditions
			// the reconnect logic exists to survive.
			for (let i = 0; i < 5; i++) {
				callbacks?.onReconnect?.()
				vi.advanceTimersByTime(1000)
			}

			// A resync is two invalidations: mark everything stale, then refetch the
			// live queries.
			expect(invalidateQueries).toHaveBeenCalledTimes(2)

			// The collapsed reconnects still get reconciled, just once.
			vi.advanceTimersByTime(10_000)
			expect(invalidateQueries).toHaveBeenCalledTimes(4)
		} finally {
			vi.useRealTimers()
		}
	})

	describe('reconnect resync against a real query client', () => {
		function setup() {
			const qc = new QueryClient()
			const wrapper = ({ children }: { children: React.ReactNode }) =>
				createElement(QueryClientProvider, { client: qc }, children)
			// Counts requests that reach the server, one counter per query.
			const mount = (queryKey: readonly unknown[]) => {
				const requests = { n: 0 }
				new QueryObserver(qc, {
					queryKey,
					queryFn: async () => {
						requests.n++
						return 'ok'
					},
					staleTime: 60_000,
				}).subscribe(() => {})
				return requests
			}
			return { qc, wrapper, mount }
		}

		const reconnect = () => {
			const callbacks = mockConnectSSE.mock.calls[0]?.[1] as { onReconnect: () => void }
			callbacks.onReconnect()
		}

		it('refetches the live queries once and leaves every other active query alone', async () => {
			vi.useFakeTimers()
			try {
				const { wrapper, mount } = setup()
				const live = {
					transcript: mount(['conversations', 'ws-1', 'detail', 'conv-1']),
					sessionsList: mount(['sessions', 'ws-1']),
					sessionsByConversation: mount(['sessions', 'ws-1', 'conversation', 'conv-1']),
				}
				const other = Array.from({ length: 12 }, (_, i) => mount(['objects', 'ws-1', 'q', i]))
				other.push(mount(['billing', 'ws-1', 'usage']), mount(['briefing', 'ws-1']))
				renderHook(() => useSSE('ws-1'), { wrapper })
				await vi.advanceTimersByTimeAsync(1)
				for (const r of [...Object.values(live), ...other]) r.n = 0

				await vi.advanceTimersByTimeAsync(11_000)
				reconnect()
				await vi.advanceTimersByTimeAsync(1_000)

				expect(live.transcript.n).toBe(1)
				expect(live.sessionsList.n).toBe(1)
				expect(live.sessionsByConversation.n).toBe(1)
				expect(other.reduce((sum, r) => sum + r.n, 0)).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		})

		it('marks the other queries stale so they refetch the next time they are used', async () => {
			vi.useFakeTimers()
			try {
				const { qc, wrapper, mount } = setup()
				mount(['objects', 'ws-1', 'list'])
				renderHook(() => useSSE('ws-1'), { wrapper })
				await vi.advanceTimersByTimeAsync(11_000)

				reconnect()

				expect(qc.getQueryState(['objects', 'ws-1', 'list'])?.isInvalidated).toBe(true)
			} finally {
				vi.useRealTimers()
			}
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
})
