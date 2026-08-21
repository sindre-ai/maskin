import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { type SSEEvent, type SSEStatus, connectSSE } from '../lib/sse'
import { invalidateFromSSE } from '../lib/sse-invalidation'

export type { SSEStatus } from '../lib/sse'

export function useSSE(workspaceId: string): SSEStatus {
	const queryClient = useQueryClient()
	const controllerRef = useRef<AbortController | null>(null)
	const [status, setStatus] = useState<SSEStatus>('connecting')

	useEffect(() => {
		if (!workspaceId) return
		setStatus('connecting')

		const controller = connectSSE(workspaceId, {
			onEvent: (event: SSEEvent) => {
				invalidateFromSSE(queryClient, workspaceId, event)
			},
			onStatusChange: setStatus,
			// A reconnect means we were disconnected for some interval. The
			// server replays missed events from Last-Event-ID but caps that at
			// 100, and a busy workspace blows through 100 events quickly — so
			// anything cached during the gap may be stale. Invalidate broadly
			// rather than trusting replay; this is what stops the chat
			// transcript from staying frozen after a dropped connection until
			// the user reloads the page.
			onReconnect: () => {
				queryClient.invalidateQueries()
			},
		})
		controllerRef.current = controller

		return () => {
			controller.abort()
			controllerRef.current = null
		}
	}, [workspaceId, queryClient])

	return status
}
