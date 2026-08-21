import { isSessionIdleAwaitingInput } from '@/components/agents/session-log-transcript'
import { api } from '@/lib/api'
import type { SessionLogResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQueries } from '@tanstack/react-query'
import { useRef } from 'react'

/** Max rows the logs endpoint will return in one call (see `sessionLogQuerySchema`). */
const PAGE_SIZE = 500

/**
 * How many pages we'll pull in a single poll to catch up. A busy turn can
 * emit more than one page between polls; without this the client would fall
 * further behind on every tick and never converge.
 */
const MAX_PAGES_PER_POLL = 5

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
 * hit the API every second when we know nothing is being produced. The next
 * user message flips it back to active within one tick.
 */
const IDLE_POLL_MS = 5000

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
 */
export function useSessionActivityLogs(workspaceId: string, sessionIds: string[]) {
	// Accumulated rows per session. A ref (not state) because the query
	// results below are what drive rendering — mutating this during a queryFn
	// must not itself schedule a render.
	const accumulated = useRef(new Map<string, SessionLogResponse[]>())

	// Drop sessions we're no longer watching so a long-lived tab doesn't hold
	// every session's transcript it has ever seen.
	const watching = new Set(sessionIds)
	for (const id of accumulated.current.keys()) {
		if (!watching.has(id)) accumulated.current.delete(id)
	}

	return useQueries({
		queries: sessionIds.map((sessionId) => ({
			queryKey: [...queryKeys.sessions.logs(sessionId), 'activity'],
			queryFn: () => fetchNewLogs(accumulated.current, sessionId, workspaceId),
			refetchInterval: (query: { state: { data?: SessionLogResponse[] } }) =>
				isAwaitingNextTurn(query.state.data) ? IDLE_POLL_MS : ACTIVE_POLL_MS,
		})),
	})
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

		// A short page means we've reached the tail; anything else means there
		// may be more waiting and we should keep pulling.
		if (rows.length < PAGE_SIZE) break
	}

	return store.get(sessionId) ?? []
}

/**
 * True once the session's most recent stdout envelope is a `result` — the
 * turn finished and the CLI is blocked reading stdin for the next one.
 *
 * Delegates to the same predicate the transcript uses to decide whether to
 * show a live dropdown, so the poll rate and the UI can't disagree about
 * whether something is in flight.
 */
function isAwaitingNextTurn(logs: SessionLogResponse[] | undefined): boolean {
	if (!logs || logs.length === 0) return false
	return isSessionIdleAwaitingInput(logs)
}
