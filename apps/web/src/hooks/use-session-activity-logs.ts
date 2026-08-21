import { isSessionIdleAwaitingInput } from '@/components/agents/session-log-transcript'
import { api } from '@/lib/api'
import type { SessionLogResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import type { UseQueryResult } from '@tanstack/react-query'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef, useState } from 'react'

/** Max rows the logs endpoint will return in one call (see `sessionLogQuerySchema`). */
const PAGE_SIZE = 500

/**
 * How many pages we'll pull in a single poll to catch up. A busy turn can
 * emit more than one page between polls; without this the client would fall
 * further behind on every tick and never converge.
 */
const MAX_PAGES_PER_POLL = 5
/**
 * Backward pages a single session may load in one mount (~3000 rows). Bounds
 * client memory on a very long-lived interactive session; the UI says so
 * rather than silently stopping.
 */
const MAX_BACKFILL_PAGES = 6

/**
 * Poll interval while a turn is actually in flight.
 *
 * End-to-end latency is this plus the agent-server's log flush interval
 * (LOG_FLUSH_INTERVAL_MS in apps/agent-server/src/index.ts), because
 * production sessions run on a separate agent-server box that batches stdout
 * and POSTs it to apps/dev, which inserts into `session_logs` — the table we
 * read here. Both terms are 1s, so a line surfaces in ~1s typical / ~2s worst
 * case. Lowering only one of the two buys nothing.
 */
const ACTIVE_POLL_MS = 1000

/**
 * Poll interval once the session has come to rest awaiting the next user
 * turn. A chat tab can sit open all day in this state; there's no reason to
 * hit the API every second when we know nothing is being produced.
 */
const IDLE_POLL_MS = 5000

/**
 * How long after the newest conversation message we stay on ACTIVE_POLL_MS
 * regardless of what the held logs say.
 *
 * Without this the idle gate costs ~5s at the worst possible moment. The
 * interval is derived from the logs we already hold, and the last envelope of
 * a finished turn is a `result` — so the hook reads "idle". Sending a message
 * doesn't change those logs, and when the responder reuses an already-running
 * session no session row is mutated either, so nothing invalidates the
 * `['sessions']` prefix (see sse-invalidation.ts) to shake it awake. The hook
 * would only learn the new turn had started on the next 5s tick, wiping out
 * the latency this hook exists to cut. Passing the newest message's timestamp
 * in makes the option identity change on send, which reschedules the interval
 * immediately rather than waiting out the idle tick.
 */
const ACTIVE_GRACE_MS = 30_000

/**
 * Streams a live session's logs by accumulating pages rather than re-reading
 * a fixed window.
 *
 * The naive version of this — `logs(id, ws, { limit: '500' })` on an interval
 * — is subtly broken for chat. An interactive session stays open for the
 * entire lifetime of a conversation and keeps appending to `session_logs`,
 * while the endpoint's default ordering returns the OLDEST `limit` rows. Past
 * ~500 rows the client was permanently pinned to the *beginning* of the
 * conversation: `segmentActivityByMessage` kept resolving the same old
 * segments, `isSessionIdleAwaitingInput` saw a long-finished `result`
 * envelope and reported idle, and the live activity dropdown vanished
 * mid-turn — with no way to recover, since every subsequent poll returned the
 * same stale window.
 *
 * Instead: hydrate from the tail (`order: 'desc'`), then page forward from a
 * `since` cursor, appending as we go. Memory is bounded by the session's own
 * lifetime, which is what the transcript needs anyway.
 *
 * `lastMessageAt` is the newest conversation message's timestamp (ms); see
 * ACTIVE_GRACE_MS for why the poll rate needs it.
 */
export interface SessionBackfillState {
	/** A full page came back last time, so there is probably more before it. */
	hasOlder: boolean
	isLoading: boolean
	/** Hit MAX_BACKFILL_PAGES — the client stops rather than growing forever. */
	exhausted: boolean
}

export interface SessionActivityLogs {
	queries: UseQueryResult<SessionLogResponse[], Error>[]
	/** Fetch the page of logs immediately before the oldest one held. */
	loadOlder: (sessionId: string) => Promise<void>
	backfill: Map<string, SessionBackfillState>
}

export function useSessionActivityLogs(
	workspaceId: string,
	sessionIds: string[],
	lastMessageAt: number | null = null,
	/**
	 * Which of `sessionIds` are still live and should be polled. Sessions
	 * absent from this set are fetched once and then left alone — that's how a
	 * terminal session's history can be loaded on demand without putting a
	 * finished conversation back on a 1s timer. Defaults to polling all.
	 */
	pollableSessionIds?: Set<string>,
): SessionActivityLogs {
	const queryClient = useQueryClient()

	// Accumulated rows per session. A ref (not state) because the query
	// results below are what drive rendering — mutating this during a queryFn
	// must not itself schedule a render.
	const accumulated = useRef(new Map<string, SessionLogResponse[]>())
	const pagesLoaded = useRef(new Map<string, number>())
	const backfilling = useRef(new Set<string>())
	const [backfill, setBackfill] = useState(new Map<string, SessionBackfillState>())

	// Drop sessions we're no longer watching so a long-lived tab doesn't hold
	// every session's transcript it has ever seen.
	const watching = new Set(sessionIds)
	for (const id of accumulated.current.keys()) {
		if (!watching.has(id)) {
			accumulated.current.delete(id)
			pagesLoaded.current.delete(id)
			backfilling.current.delete(id)
		}
	}

	const queries = useQueries({
		queries: sessionIds.map((sessionId) => {
			const queryKey = [...queryKeys.sessions.logs(sessionId), 'activity']
			return {
				queryKey,
				queryFn: () => {
					// The ref is per hook instance but the cache is global, so a
					// remount (navigate away and back within gcTime) starts with an
					// empty ref in front of a fully populated cache entry. Without
					// this seed the first fetch would see no cursor, take the
					// `order: 'desc'` hydrate branch, and overwrite an accumulated
					// 3000-row transcript with the newest 500 — visibly truncating
					// the conversation, which is the very bug this hook exists to
					// fix.
					const store = accumulated.current
					if (!store.has(sessionId)) {
						const cached = queryClient.getQueryData<SessionLogResponse[]>(queryKey)
						if (cached && cached.length > 0) store.set(sessionId, cached)
					}
					return fetchNewLogs(store, sessionId, workspaceId)
				},
				refetchInterval: (query: { state: { data?: SessionLogResponse[] } }) =>
					pollableSessionIds && !pollableSessionIds.has(sessionId)
						? (false as const)
						: activityPollInterval(query.state.data, lastMessageAt),
			}
		}),
	}) as UseQueryResult<SessionLogResponse[], Error>[]

	/**
	 * Page backward from the oldest row currently held for a session.
	 *
	 * Older rows are prepended; the forward cursor is the TAIL of the same
	 * array, so backfilling never disturbs polling. The merged array is written
	 * back with a fresh identity because the ref is invisible to React — without
	 * a new array the query cache holds the same reference and nothing re-renders.
	 */
	const loadOlder = useCallback(
		async (sessionId: string) => {
			if (backfilling.current.has(sessionId)) return
			const store = accumulated.current
			const existing = store.get(sessionId) ?? []
			const oldestId = existing[0]?.id
			if (oldestId === undefined) return
			if ((pagesLoaded.current.get(sessionId) ?? 0) >= MAX_BACKFILL_PAGES) return

			backfilling.current.add(sessionId)
			setBackfill((prev) => nextBackfill(prev, sessionId, { isLoading: true }))
			try {
				const rows = await api.sessions.logs(sessionId, workspaceId, {
					limit: String(PAGE_SIZE),
					order: 'desc',
					before: String(oldestId),
				})

				const current = store.get(sessionId) ?? []
				const seen = new Set(current.map((l) => l.id))
				const fresh = rows.filter((l) => !seen.has(l.id))
				if (fresh.length > 0) {
					const merged = [...current, ...fresh].sort((a, b) => a.id - b.id)
					store.set(sessionId, merged)
					queryClient.setQueryData([...queryKeys.sessions.logs(sessionId), 'activity'], [...merged])
				}

				const pages = (pagesLoaded.current.get(sessionId) ?? 0) + 1
				pagesLoaded.current.set(sessionId, pages)
				setBackfill((prev) =>
					nextBackfill(prev, sessionId, {
						isLoading: false,
						hasOlder: rows.length === PAGE_SIZE,
						exhausted: pages >= MAX_BACKFILL_PAGES,
					}),
				)
			} catch {
				// Leave hasOlder as-is so the control stays available to retry.
				setBackfill((prev) => nextBackfill(prev, sessionId, { isLoading: false }))
			} finally {
				backfilling.current.delete(sessionId)
			}
		},
		[queryClient, workspaceId],
	)

	return { queries, loadOlder, backfill }
}

function nextBackfill(
	prev: Map<string, SessionBackfillState>,
	sessionId: string,
	patch: Partial<SessionBackfillState>,
): Map<string, SessionBackfillState> {
	const next = new Map(prev)
	const current = prev.get(sessionId) ?? { hasOlder: true, isLoading: false, exhausted: false }
	next.set(sessionId, { ...current, ...patch })
	return next
}

async function fetchNewLogs(
	store: Map<string, SessionLogResponse[]>,
	sessionId: string,
	workspaceId: string,
): Promise<SessionLogResponse[]> {
	for (let page = 0; page < MAX_PAGES_PER_POLL; page++) {
		const existing = store.get(sessionId) ?? []
		const cursor = existing.length > 0 ? existing[existing.length - 1]?.id : undefined

		const rows = await api.sessions.logs(sessionId, workspaceId, {
			limit: String(PAGE_SIZE),
			// No cursor yet — this is the first load for this session, so take
			// the newest page rather than the oldest. Subsequent polls page
			// forward from the cursor in ascending order.
			...(cursor === undefined ? { order: 'desc' } : { since: String(cursor) }),
		})

		// Guard against re-entrancy (React strict mode double-invokes, and a
		// refetch can overlap a slow in-flight poll) — appending blind would
		// duplicate steps in the transcript.
		const seen = new Set(existing.map((l) => l.id))
		const fresh = rows.filter((l) => !seen.has(l.id))
		if (fresh.length > 0) {
			store.set(
				sessionId,
				[...existing, ...fresh].sort((a, b) => a.id - b.id),
			)
		}

		// A short page means we've reached the tail. A full page that was
		// entirely duplicates leaves the cursor where it was, so continuing
		// would just refetch the same 500 rows — stop on that too.
		if (fresh.length === 0 || rows.length < PAGE_SIZE) break
	}

	return store.get(sessionId) ?? []
}

/**
 * How often to re-read a session's logs.
 *
 * Idle means the session's most recent stdout envelope is a `result` — the
 * turn finished and the CLI is blocked reading stdin for the next one. That
 * check delegates to the same predicate the transcript uses to decide whether
 * to show a live dropdown, so the poll rate and the UI can't disagree about
 * whether something is in flight. A recent message overrides it (see
 * ACTIVE_GRACE_MS), because a turn that has just been prompted hasn't
 * produced any logs to read yet.
 *
 * Exported for tests: this is the whole of the latency behaviour, and it is
 * awkward to observe through the query observer.
 */
export function activityPollInterval(
	logs: SessionLogResponse[] | undefined,
	lastMessageAt: number | null,
	now: number = Date.now(),
): number {
	if (lastMessageAt !== null && now - lastMessageAt < ACTIVE_GRACE_MS) return ACTIVE_POLL_MS
	if (!logs || logs.length === 0) return ACTIVE_POLL_MS
	return isSessionIdleAwaitingInput(logs) ? IDLE_POLL_MS : ACTIVE_POLL_MS
}
