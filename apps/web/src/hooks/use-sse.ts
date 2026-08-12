import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type SSEEvent, type SSEStatus, connectSSE } from '../lib/sse'
import { invalidateFromSSE } from '../lib/sse-invalidation'

export type { SSEStatus } from '../lib/sse'

export function useSSE(workspaceId: string): SSEStatus {
	const queryClient = useQueryClient()
	const controllerRef = useRef<AbortController | null>(null)
	const [status, setStatus] = useState<SSEStatus>('connecting')

	const connect = useCallback(() => {
		if (!workspaceId) return
		controllerRef.current?.abort()
		setStatus('connecting')

		const controller = connectSSE(workspaceId, {
			onEvent: (event: SSEEvent) => {
				invalidateFromSSE(queryClient, workspaceId, event)
			},
			onStatusChange: setStatus,
		})
		controllerRef.current = controller
	}, [workspaceId, queryClient])

	useEffect(() => {
		connect()
		return () => {
			controllerRef.current?.abort()
			controllerRef.current = null
		}
	}, [connect])

	// On return to the foreground the OS may have severed/suspended the stream;
	// reconnect so the persisted Last-Event-ID replays anything missed while hidden.
	useEffect(() => {
		if (!workspaceId) return
		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible') connect()
		}
		document.addEventListener('visibilitychange', onVisibilityChange)
		return () => document.removeEventListener('visibilitychange', onVisibilityChange)
	}, [connect, workspaceId])

	return status
}
