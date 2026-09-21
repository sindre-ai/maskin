import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
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

import {
	DONE_GRACE_TICK_MS,
	activityPollInterval,
	useSessionActivityLogs,
} from '@/hooks/use-session-activity-logs'
import { api } from '@/lib/api'
import type { SessionLogResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
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

/**
 * The option bag a query was created with, read off the query cache.
 *
 * `refetchInterval` and `refetchOnWindowFocus` are observer-level options: a
 * `Query` is typed as holding `QueryOptions`, which omits them, but at runtime
 * it is the observer's full option bag that lands on `query.options`. The cast
 * bridges that gap so the assertions read the real values rather than a
 * structurally-narrowed view of them.
 */
function observerOptions(
	client: QueryClient,
	queryKey: readonly unknown[],
): { refetchInterval?: unknown; refetchOnWindowFocus?: unknown } | undefined {
	return client.getQueryCache().find({ queryKey })?.options as
		| { refetchInterval?: unknown; refetchOnWindowFocus?: unknown }
		| undefined
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
	/**
	 * Capture the stream callbacks the hook registers, keyed by session id.
	 * `log` is the line listener; `done` is the terminal-state listener the hook
	 * uses to stop the fast poll and arm its single backstop tick.
	 */
	function captureStreamListeners() {
		const log = new Map<string, (log: SessionLogResponse) => void>()
		const done = new Map<string, () => void>()
		vi.mocked(subscribeToSessionLogs).mockImplementation((_ws, sid, onLog, onDone) => {
			log.set(sid, onLog)
			if (onDone) done.set(sid, onDone)
			return () => {
				log.delete(sid)
				done.delete(sid)
			}
		})
		return { log, done }
	}

	function render(sessionIds = [sessionId]) {
		return renderHook(
			() => useSessionActivityLogs(workspaceId, sessionIds, null, new Set(sessionIds)),
			{ wrapper: TestWrapper },
		)
	}

	it('renders a line that arrived only on the stream', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const { log } = captureStreamListeners()

		const { result } = render()
		await waitFor(() => expect(result.current.queries[0]?.data).toEqual([]))

		log.get(sessionId)?.(buildLog(5))

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
		const { log } = captureStreamListeners()
		const streamOnly = render()
		await waitFor(() => expect(streamOnly.result.current.queries[0]?.data).toEqual([]))
		const onLog = log.get(sessionId)
		onLog?.(buildLog(1))
		onLog?.(buildLog(2))
		onLog?.(buildLog(3))
		await waitFor(() => expect(streamOnly.result.current.queries[0]?.data).toHaveLength(3))
		expect(streamOnly.result.current.queries[0]?.data?.map((l) => l.id)).toEqual([1, 2, 3])
		streamOnly.unmount()

		// stream+poll, with the poll re-delivering lines the stream already
		// rendered — the mid-reconnect overlap the spec calls out. Dedup on id
		// must make it converge on the identical array rather than duplicating.
		const { log: log2 } = captureStreamListeners()
		const both = render()
		await waitFor(() => expect(both.result.current.queries[0]?.data).toEqual([]))
		const onLog2 = log2.get(sessionId)
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
		const { log } = captureStreamListeners()

		// A terminal session's history is fetched once and then left alone, so
		// no stream is opened for it.
		renderHook(() => useSessionActivityLogs(workspaceId, [sessionId], null, new Set<string>()), {
			wrapper: TestWrapper,
		})

		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalled())
		expect(subscribeToSessionLogs).not.toHaveBeenCalled()
		expect(log.size).toBe(0)
	})

	it('tears the stream down on unmount', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const { log } = captureStreamListeners()

		const { unmount } = render()
		await waitFor(() => expect(log.has(sessionId)).toBe(true))

		unmount()

		expect(log.has(sessionId)).toBe(false)
	})

	it('stops the fast poll on done and fires exactly one backstop fetch, then stops', async () => {
		// The bet's "slow backstop" rule: the stream is authoritative for a live
		// turn, but a dropped connection once froze a transcript with nothing to
		// catch up. So `done` must silence the fast poll and leave exactly ONE
		// late fetch to pick up any final lines — not an interval.
		vi.useFakeTimers({ shouldAdvanceTime: true })
		try {
			vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(1)])
			const { done } = captureStreamListeners()

			const { result } = render()
			await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(1))

			await act(async () => {
				done.get(sessionId)?.()
			})

			vi.mocked(api.sessions.logs).mockClear()

			// Just short of the grace tick: the 2s poll must already be dead, so
			// nothing at all should have been fetched.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(DONE_GRACE_TICK_MS - 1_000)
			})
			expect(api.sessions.logs).not.toHaveBeenCalled()

			await act(async () => {
				await vi.advanceTimersByTimeAsync(1_000)
			})
			expect(api.sessions.logs).toHaveBeenCalledTimes(1)

			// Several more grace windows: still the one fetch, because the
			// backstop is a single tick rather than a repeating interval.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(DONE_GRACE_TICK_MS * 4)
			})
			expect(api.sessions.logs).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it('drops the poll interval entirely once the session reports done', async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client }, children)

		vi.mocked(api.sessions.logs).mockResolvedValue([buildLog(1)])
		const { done } = captureStreamListeners()

		const { result } = renderHook(
			() => useSessionActivityLogs(workspaceId, [sessionId], null, new Set([sessionId])),
			{ wrapper },
		)
		await waitFor(() => expect(result.current.queries[0]?.data).toHaveLength(1))

		const key = [...queryKeys.sessions.logs(sessionId), 'activity']
		const query = client.getQueryCache().find({ queryKey: key })
		const intervalNow = () =>
			observerOptions(client, key)?.refetchInterval as ((query: unknown) => unknown) | undefined

		expect(typeof intervalNow()).toBe('function')
		expect(intervalNow()?.(query)).not.toBe(false)

		await act(async () => {
			done.get(sessionId)?.()
		})

		// TanStack clears an armed interval when the option flips to false; the
		// single backstop fetch is scheduled separately by the hook.
		expect(intervalNow()?.(query)).toBe(false)
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

describe('useSessionActivityLogs focus scoping', () => {
	/**
	 * A client that mirrors apps/web/src/lib/query.ts: the app-wide default is
	 * refetchOnWindowFocus:false. TestWrapper does not set that default (it
	 * inherits TanStack's own true), so a focus test has to build the app-like
	 * client explicitly or it would prove nothing about the app.
	 */
	function appLikeClient() {
		return new QueryClient({
			defaultOptions: {
				queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
			},
		})
	}

	function renderWithUnrelated(client: QueryClient) {
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(QueryClientProvider, { client }, children)
		const unrelatedFetch = vi.fn()
		const hook = renderHook(
			() => {
				const activity = useSessionActivityLogs(
					workspaceId,
					[sessionId],
					null,
					new Set([sessionId]),
				)
				const other = useQuery({
					queryKey: ['unrelated'],
					queryFn: async () => {
						unrelatedFetch()
						return 1
					},
				})
				return { activity, other }
			},
			{ wrapper },
		)
		return { ...hook, unrelatedFetch }
	}

	const logsKey = [...queryKeys.sessions.logs(sessionId), 'activity']

	it('opts the chat/logs query in while the client default stays out', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const client = appLikeClient()
		expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)

		const { result } = renderWithUnrelated(client)
		await waitFor(() => expect(result.current.activity.queries[0]?.data).toEqual([]))
		await waitFor(() => expect(result.current.other.isSuccess).toBe(true))

		// The scoping is per-query, not a global flip: exactly the chat/logs
		// query opts in.
		expect(observerOptions(client, logsKey)?.refetchOnWindowFocus).toBe(true)
		expect(observerOptions(client, ['unrelated'])?.refetchOnWindowFocus).toBe(false)
	})

	it('refetches chat/logs on visibilitychange but leaves unrelated queries alone', async () => {
		vi.mocked(api.sessions.logs).mockResolvedValue([])
		const client = appLikeClient()
		const { result, unrelatedFetch } = renderWithUnrelated(client)
		await waitFor(() => expect(result.current.activity.queries[0]?.data).toEqual([]))
		await waitFor(() => expect(result.current.other.isSuccess).toBe(true))

		vi.mocked(api.sessions.logs).mockClear()
		unrelatedFetch.mockClear()

		await act(async () => {
			window.dispatchEvent(new Event('visibilitychange'))
		})

		// A live chat uniquely has something new to show when the tab comes
		// back, so it catches up immediately...
		await waitFor(() => expect(api.sessions.logs).toHaveBeenCalledTimes(1))
		// ...while the objects/events/notifications/billing queries that share
		// this client stay put, which is the whole point of not flipping the
		// app-wide default.
		expect(unrelatedFetch).not.toHaveBeenCalled()
	})
})
