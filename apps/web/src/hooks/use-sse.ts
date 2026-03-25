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
		})
		controllerRef.current = controller

		return () => {
			controller.abort()
			controllerRef.current = null
		}
	}, [workspaceId, queryClient])

	return status
}
