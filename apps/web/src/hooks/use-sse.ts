import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { type SSEEvent, SSEFatalError, type SSEStatus, connectSSE } from '../lib/sse'
import { invalidateFromSSE } from '../lib/sse-invalidation'

export type { SSEStatus } from '../lib/sse'

/**
 * Floor between two reconnect-driven cache resyncs.
 *
 * The resync is deliberately broad, so it must not be able to run in a tight
 * loop. `onopen` fires on every attempt fetch-event-source makes internally,
 * including its own 1s retries, so a flapping backend or a proxy that
 * repeatedly half-opens the stream would otherwise refetch every active query
 * in the app once a second — a self-inflicted request storm in exactly the
 * degraded conditions this reconnect logic exists to survive. Reconnects
 * inside the window collapse into a single trailing resync.
 */
const MIN_RECONNECT_SYNC_MS = 10_000

// Query-key roots that are rendered live and have nothing else to catch them up
// after a gap: the chat transcript (conversations) and session state (sessions).
// Only these refetch on reconnect; every other query is just marked stale and
// refetches the next time something mounts it.
const LIVE_RESYNC_ROOTS = new Set<unknown>(['conversations', 'sessions'])
const isLiveQuery = (query: { queryKey: readonly unknown[] }) =>
	LIVE_RESYNC_ROOTS.has(query.queryKey[0])

export function useSSE(workspaceId: string): SSEStatus {
	const queryClient = useQueryClient()
	const controllerRef = useRef<AbortController | null>(null)
	const lastSyncAtRef = useRef(0)
	const pendingSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const [status, setStatus] = useState<SSEStatus>('connecting')

	useEffect(() => {
		if (!workspaceId) return
		setStatus('connecting')

		const resync = () => {
			lastSyncAtRef.current = Date.now()
			pendingSyncRef.current = null
			queryClient.invalidateQueries({
				predicate: (query) => !isLiveQuery(query),
				refetchType: 'none',
			})
			queryClient.invalidateQueries({ predicate: isLiveQuery }, { cancelRefetch: false })
		}

		const controller = connectSSE(workspaceId, {
			onEvent: (event: SSEEvent) => {
				invalidateFromSSE(queryClient, workspaceId, event)
			},
			onStatusChange: setStatus,
			// Without this every SSE error was discarded — a revoked key and a
			// flaky network were both just a "disconnected" chip. A fatal one
			// ends the subscription, so it's the last thing the user will hear
			// about it; make sure it reaches the console at least.
			onError: (err) => {
				if (err instanceof SSEFatalError) {
					console.error('[sse] subscription ended', err.status, err.message)
				}
			},
			// A reconnect means we were disconnected for some interval. The
			// server replays missed events from Last-Event-ID but caps that at
			// 100, and a busy workspace blows through 100 events quickly — so
			// anything cached during the gap may be stale. Mark everything stale
			// rather than trusting replay, but refetch only the live-rendered
			// queries now (see LIVE_RESYNC_ROOTS): a deploy drops every tab's
			// stream at once, and refetching every active query per tab made
			// each deploy a request spike. This is what stops the chat
			// transcript from staying frozen after a dropped connection until
			// the user reloads the page.
			onReconnect: () => {
				const elapsed = Date.now() - lastSyncAtRef.current
				if (elapsed >= MIN_RECONNECT_SYNC_MS) {
					resync()
					return
				}
				// Already synced recently. Collapse this reconnect into the
				// trailing resync rather than dropping it — the gap it covers
				// still needs to be reconciled, just not right now.
				if (pendingSyncRef.current !== null) return
				pendingSyncRef.current = setTimeout(resync, MIN_RECONNECT_SYNC_MS - elapsed)
			},
		})
		controllerRef.current = controller

		return () => {
			controller.abort()
			controllerRef.current = null
			if (pendingSyncRef.current !== null) {
				clearTimeout(pendingSyncRef.current)
				pendingSyncRef.current = null
			}
		}
	}, [workspaceId, queryClient])

	return status
}
