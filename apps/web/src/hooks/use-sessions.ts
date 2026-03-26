import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

export function useSession(id: string | null, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.detail(id ?? ''),
		queryFn: () => api.sessions.get(id as string, workspaceId),
		enabled: !!id,
	})
}

export function useSessionLatestLog(sessionId: string | null, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.logs(sessionId ?? ''),
		queryFn: async () => {
			const logs = await api.sessions.logs(sessionId as string, workspaceId, {
				limit: '5',
				stream: 'stdout',
			})
			return logs.length > 0 ? logs[logs.length - 1] : null
		},
		enabled: !!sessionId,
	})
}

export function useWorkspaceSessions(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.all(workspaceId),
		queryFn: () => api.sessions.list(workspaceId, { limit: '100' }),
		enabled: !!workspaceId,
	})
}

export function useActiveSessionsForActor(actorId: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.byActor(workspaceId, actorId),
		queryFn: () => api.sessions.list(workspaceId, { actor_id: actorId, status: 'running' }),
		enabled: !!actorId && !!workspaceId,
	})
}
