import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import type { TeachRequest } from '@maskin/shared'
import { useMutation, useQuery } from '@tanstack/react-query'

/**
 * Connect to one agent's computer. A mutation rather than a query: each call
 * mints a single-use ticket, so the response must never be cached or replayed,
 * and the first call can take up to a minute while the VM boots (a few seconds
 * if it was asleep).
 */
export function useConnectDesktop(workspaceId: string, agentId: string) {
	return useMutation({
		mutationFn: () => api.desktop.connect(workspaceId, agentId),
	})
}

export function useRemoveDesktop(workspaceId: string, agentId: string) {
	return useMutation({
		mutationFn: () => api.desktop.remove(workspaceId, agentId),
	})
}

/** Which agents have a computer, and whether it is asleep. Polled gently; never wakes one. */
export function useDesktops(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.desktops.all(workspaceId),
		queryFn: () => api.desktop.list(workspaceId),
		refetchInterval: 15_000,
	})
}

/** Hands a recorded demonstration to the chosen agent (see "Teach a task"). */
export function useTeachDesktop(workspaceId: string) {
	return useMutation({
		mutationFn: (body: TeachRequest) => api.desktop.teach(workspaceId, body),
	})
}
