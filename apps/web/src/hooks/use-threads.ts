import {
	type AddThreadParticipantInput,
	type CreateThreadEventInput,
	type CreateThreadInput,
	type UpdateThreadInput,
	api,
} from '@/lib/api'
import { getApiKey } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

export function useThreads(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.threads.list(workspaceId, filters),
		queryFn: () => api.threads.list(workspaceId, filters),
		enabled: !!workspaceId,
	})
}

export function useThread(workspaceId: string, threadId: string | null) {
	return useQuery({
		queryKey: queryKeys.threads.detail(threadId ?? ''),
		queryFn: () => api.threads.get(threadId as string, workspaceId),
		enabled: !!threadId && !!workspaceId,
	})
}

export function useCreateThread(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateThreadInput) => api.threads.create(workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.all(workspaceId) })
		},
	})
}

export function usePostThreadEvent(workspaceId: string, threadId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateThreadEventInput) =>
			api.threads.postEvent(threadId, workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.detail(threadId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.all(workspaceId) })
		},
	})
}

export function useResolveThread(workspaceId: string, threadId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: UpdateThreadInput) => api.threads.update(threadId, workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.detail(threadId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.all(workspaceId) })
		},
	})
}

export function useUpdateThread(workspaceId: string, threadId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: UpdateThreadInput) => api.threads.update(threadId, workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.detail(threadId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.all(workspaceId) })
		},
	})
}

export function useAddThreadParticipant(workspaceId: string, threadId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: AddThreadParticipantInput) =>
			api.threads.addParticipant(threadId, workspaceId, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.threads.detail(threadId) })
		},
	})
}

export function useThreadEventStream(
	threadId: string | null,
	workspaceId: string,
	onEvent: (event: MessageEvent) => void,
) {
	const onEventRef = useRef(onEvent)
	onEventRef.current = onEvent

	useEffect(() => {
		if (!threadId || !workspaceId) return
		const apiKey = getApiKey()
		const url = `${API_BASE}/threads/${threadId}/events/stream`

		// Use a fetch-based approach instead of native EventSource since
		// EventSource doesn't support custom headers (Authorization, X-Workspace-Id)
		const controller = new AbortController()
		;(async () => {
			try {
				const res = await fetch(url, {
					signal: controller.signal,
					headers: {
						...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
						'X-Workspace-Id': workspaceId,
						Accept: 'text/event-stream',
					},
				})
				if (!res.body) return
				const reader = res.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ''
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					const lines = buffer.split('\n')
					buffer = lines.pop() ?? ''
					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const data = line.slice(6)
							if (data.trim()) {
								const event = new MessageEvent('message', { data })
								onEventRef.current(event)
							}
						}
					}
				}
			} catch {
				// aborted or stream ended
			}
		})()

		return () => controller.abort()
	}, [threadId, workspaceId])
}
