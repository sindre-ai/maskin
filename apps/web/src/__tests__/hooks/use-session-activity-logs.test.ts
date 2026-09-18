import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { type ReactNode, createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: {
		sessions: { logs: vi.fn() },
	},
}))

vi.mock('@/lib/session-log-stream', () => ({
	subscribeToSessionLogs: vi.fn(() => () => {}),
}))

import { activityPollInterval, useSessionActivityLogs } from '@/hooks/use-session-activity-logs'
import { api } from '@/lib/api'
import type { SessionLogResponse } from '@/lib/api'
import { subscribeToSessionLogs } from '@/lib/session-log-stream'
import { TestWrapper } from '../setup'

const workspaceId = 'ws-1'
const sessionId = '11111111-1111-1111-1111-111111111111'

function buildLog(id: number, content = `line ${id}`): SessionLogResponse {
	return {
		id,
		sessionId,
		stream: 'stdout',
		content,
		createdAt: new Date(id).toISOString(),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe('useSessionActivityLogs', () => {
	it('hydrates from the tail of a long-lived session, not the head', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(900), buildLog(901)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))

		// The first request must ask for the newest page. Without this an
		// interactive chat session past the row limit stays pinned to the
		// start of the conversation and the live turn never renders.
		expect(api.sessions.logs).toHaveBeenCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ order: 'desc' }),
		)
	})

	it('pages forward from a since cursor and appends', async () => {
		vi.mocked(api.sessions.logs)
			.mockResolvedValueOnce([buildLog(1), buildLog(2)])
			.mockResolvedValue([buildLog(3)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))

		await result.current.queries[0]?.refetch?.()

		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(3))
		expect(result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
		expect(api.sessions.logs).toHaveBeenLastCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ since: '2' }),
		)
	})

	it('stops paging when a full page is entirely rows it already holds', async () => {
		// A page that adds nothing leaves the cursor where it was, so looping
		// again would refetch the identical page. One call per poll, not five.
		vi.mocked(api.sessions.logs)
			.mockResolvedValueOnce([buildLog(1), buildLog(2)])
			.mockResolvedValue([buildLog(1), buildLog(2)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))
		vi.mocked(api.sessions.logs).mockClear()
		await result.current.queries[0]?.refetch?.()

		expect(api.sessions.logs).toHaveBeenCalledTimes(1)
	})

	it('resumes from the cached rows after a remount instead of truncating to the tail', async () => {
		// The accumulator is per hook instance but the query cache is global.
		// Without seeding the accumulator from the cache, a remount re-hydrates
		// with `order: desc` and overwrites a long transcript with the newest
		// page — re-introducing the very truncation this hook exists to fix.
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
		})
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client: queryClient }, children)

		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(1), buildLog(2)])
		const first = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), { wrapper })
		await waitFor(() => expect(first.result.current.queries[0]?.data).toHaveLength(2))
		first.unmount()

		vi.mocked(api.sessions.logs).mockClear()
		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(3)])
		const second = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), { wrapper })
		await waitFor(() => expect(second.result.current.queries[0]?.data).toHaveLength(3))

		expect(second.result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
		expect(api.sessions.logs).toHaveBeenLastCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ since: '2' }),
		)
	})

	it('does not duplicate rows when a page overlaps what is already held', async () => {
		vi.mocked(api.sessions.logs)
			.mockResolvedValueOnce([buildLog(1), buildLog(2)])
			.mockResolvedValue([buildLog(2), buildLog(3)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))
		await result.current.queries[0]?.refetch?.()

		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(3))
		expect(result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
	})
})

describe('useSessionActivityLogs stream merge', () => {
	/** Capture the stream callbacks the hook registers, keyed by session id. */
	function captureStreamListeners() {
		const listeners = new Map<string, (log: SessionLogResponse) => void>()
		vi.mocked(subscribeToSessionLogs).mockImplementation((_ws, sid, onLog) => {
			listeners.set(sid, onLog)
			return () => {
				listeners.delete(sid)
			}
		})
		return listeners
	}

	function render(sessionIds = [sessionId]) {
		return renderHook(
			() => useSessionActivityLogs(workspaceId, sessionIds, null, new Set(sessionIds)),
			{ wrapper: TestWrapper },
		)
	}

	it('renders a line that arrived only on the stream', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const listeners = captureStreamListeners()

		const { result } = render()
		await waitFor(() => expect(result.current.queries[0]?.data).toEqual([]))

		listeners.get(sessionId)?.(buildLog(5))

		await waitFor(() => expect(result.current.queries[0]?.data?.map((l) => l.id)).toEqual([5]))
	})

	it('converges on the same rows for stream-only, poll-only and stream+poll', async () => {
		// poll-only
		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(1), buildLog(2), buildLog(3)])
		const pollOnly = render()
		await waitFor(() => expect(pollOnly.result.current.queries[0]?.data).toHaveLength(3))
		expect(pollOnly.result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
		pollOnly.unmount()

		// stream-only
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const listeners = captureStreamListeners()
		const streamOnly = render()
		await waitFor(() => expect(streamOnly.result.current.queries[0]?.data).toEqual([]))
		const onLog = listeners.get(sessionId)
		onLog?.(buildLog(1))
		onLog?.(buildLog(2))
		onLog?.(buildLog(3))
		await waitFor(() => expect(streamOnly.result.current.queries[0]?.data).toHaveLength(3))
		expect(streamOnly.result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
		streamOnly.unmount()

		// stream+poll, with the poll re-delivering lines the stream already
		// rendered — the mid-reconnect overlap the spec calls out. Dedup on id
		// must make it converge on the identical array rather than duplicating.
		const listeners2 = captureStreamListeners()
		const both = render()
		await waitFor(() => expect(both.result.current.queries[0]?.data).toEqual([]))
		const onLog2 = listeners2.get(sessionId)
		onLog2?.(buildLog(1))
		onLog2?.(buildLog(2))
		onLog2?.(buildLog(3))
		await waitFor(() => expect(both.result.current.queries[0]?.data).toHaveLength(3))

		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(2), buildLog(3), buildLog(4)])
		await both.result.current.queries[0]?.refetch()

		await waitFor(() => expect(both.result.current.queries[0]?.data).toHaveLength(4))
		expect(both.result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3, 4])
	})

	it('subscribes only to the pollable session ids', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const listeners = captureStreamListeners()

		// A terminal session's history is fetched once and then left alone, so
		// no stream is opened for it.
		renderHook(() => useSessionActivityLogs(workspaceId, [sessionId], null, new Set<string>()), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())
		expect(subscribeToSessionLogs).not.toHaveBeenCalled()
		expect(listeners.size).toBe(0)
	})

	it('tears the stream down on unmount', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const listeners = captureStreamListeners()

		const { unmount } = render()
		await waitFor(() => expect(listeners.has(sessionId)).toBe(true))

		unmount()

		expect(listeners.has(sessionId)).toBe(false)
	})
})

describe('activityPollInterval', () => {
	const finishedTurn = [
		buildLog(1, JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })),
	]
	const midTurn = [
		buildLog(1, JSON.stringify({ type: 'assistant', message: { id: 'm', content: [] } })),
	]
	const now = 1_000_000

	it('backs off once the last envelope is a finished result', () => {
		expect(activityPollInterval(finishedTurn, null, now)).toBe(5000)
	})

	it('polls fast while a turn is in flight', () => {
		expect(activityPollInterval(midTurn, null, now)).toBe(2000)
	})

	it('polls fast when nothing has been read yet', () => {
		expect(activityPollInterval([], null, now)).toBe(2000)
		expect(activityPollInterval(undefined, null, now)).toBe(2000)
	})

	it('polls fast right after a message even though the held logs read as idle', () => {
		// The whole point: a reused running session mutates no session row, so
		// nothing invalidates these logs when the user sends a message. Without
		// the timestamp the transcript would sit on the 5s idle tick at the
		// most latency-sensitive moment of the interaction.
		expect(activityPollInterval(finishedTurn, now - 2000, now)).toBe(2000)
	})

	it('returns to the idle interval once the grace window has passed', () => {
		expect(activityPollInterval(finishedTurn, now - 60_000, now)).toBe(5000)
	})
})

describe('useSessionActivityLogs backward paging', () => {
	it('pages backward from the oldest held row and prepends', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(500), buildLog(501)])

		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))

		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(498), buildLog(499)])
		await result.current.loadOlder(sessionId)

		expect(api.sessions.logs).toHaveBeenLastCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ order: 'desc', before: '500' }),
		)
		await waitFor(() =>
			expect(result.current.queries[0]?.data?.map((l) => l.id)).toEqual([498, 499, 500, 501]),
		)
	})

	it('leaves the forward cursor on the tail so polling is unaffected', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(500), buildLog(501)])
		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))

		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(498)])
		await result.current.loadOlder(sessionId)

		// Backfilling prepends; the next poll must still resume from the newest
		// row held (501), not from the oldest one we just pulled in.
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		await result.current.queries[0]?.refetch()
		expect(api.sessions.logs).toHaveBeenLastCalledWith(
			sessionId,
			workspaceId,
			expect.objectContaining({ since: '501' }),
		)
	})

	it('dedupes rows that overlap what is already held', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(10), buildLog(11)])
		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(2))

		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(9), buildLog(10)])
		await result.current.loadOlder(sessionId)

		await waitFor(() =>
			expect(result.current.queries[0]?.data?.map((l) => l.id)).toEqual([9, 10, 11]),
		)
	})

	it('reports hasOlder false when a short page comes back', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(10)])
		const { result } = renderHook(() => useSessionActivityLogs(workspaceId, [sessionId]), {
			wrapper: TestWrapper,
		})
		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(1))

		vi.mocked(api.sessions.logs).mockResolvedValueOnce([buildLog(9)])
		await result.current.loadOlder(sessionId)

		await waitFor(() => expect(result.current.backfill.get(sessionId)?.hasOlder).toBe(false))
	})

	it('does not poll sessions left out of the pollable set', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(1)])

		const { result } = renderHook(
			() => useSessionActivityLogs(workspaceId, [sessionId], null, new Set<string>()),
			{ wrapper: TestWrapper },
		)
		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(1))

		// A terminal session's history is fetched once on opt-in and then left
		// alone — putting a finished conversation back on a 1s timer would be a
		// pure cost with nothing to show for it.
		expect(result.current.queries[0]?.isRefetching).toBe(false)
	})
})
