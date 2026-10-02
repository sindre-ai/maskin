import { api } from '@/lib/api'
import type { TeachRequest } from '@maskin/shared'
import { useMutation } from '@tanstack/react-query'

/**
 * Connect to the workspace desktop. A mutation rather than a query: each call
 * mints a single-use ticket, so the response must never be cached or replayed,
 * and the first call can take up to a minute while the VM boots.
 */
export function useConnectDesktop(workspaceId: string) {
	return useMutation({
		mutationFn: () => api.desktop.connect(workspaceId),
	})
}

export function useRemoveDesktop(workspaceId: string) {
	return useMutation({
		mutationFn: () => api.desktop.remove(workspaceId),
	})
}

/** Hands a recorded demonstration to the chosen agent (see "Teach a task"). */
export function useTeachDesktop(workspaceId: string) {
	return useMutation({
		mutationFn: (body: TeachRequest) => api.desktop.teach(workspaceId, body),
	})
}
