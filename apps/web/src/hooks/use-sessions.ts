import { api } from '@/lib/api'
import type { CreateSessionInput } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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

export function useCreateSession(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateSessionInput) => api.sessions.create(workspaceId, data),
		onSuccess: (_result, data) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.sessions.byActor(workspaceId, data.actor_id),
			})
		},
	})
}

export function useActiveSessionsForActor(actorId: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.byActor(workspaceId, actorId),
		queryFn: () => api.sessions.list(workspaceId, { actor_id: actorId, status: 'running' }),
		enabled: !!actorId && !!workspaceId,
	})
}

export function useSessionErrorLog(
	sessionId: string | null,
	workspaceId: string,
	enabled: boolean,
) {
	return useQuery({
		queryKey: [...queryKeys.sessions.logs(sessionId ?? ''), 'stderr'],
		queryFn: async () => {
			const logs = await api.sessions.logs(sessionId as string, workspaceId, {
				limit: '5',
				stream: 'stderr',
			})
			return logs.length > 0 ? logs.map((l) => l.content).join('\n') : null
		},
		enabled: !!sessionId && enabled,
	})
}

export function useActorSessions(actorId: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.byActorAll(workspaceId, actorId),
		queryFn: () => api.sessions.list(workspaceId, { actor_id: actorId, limit: '20' }),
		enabled: !!actorId && !!workspaceId,
	})
}

export function useSessionLogs(sessionId: string | null, workspaceId: string, enabled = true) {
	return useQuery({
		queryKey: [...queryKeys.sessions.logs(sessionId ?? ''), 'all'],
		queryFn: () => api.sessions.logs(sessionId as string, workspaceId, { limit: '500' }),
		enabled: !!sessionId && enabled,
	})
}

// Send a message into a running session. The backend writes a `user_message` row
// in session_logs, which (a) appears for everyone watching the live stream and
// (b) is read by the agent runtime on its next turn.
export function useSendUserMessage(sessionId: string, workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (content: string) => api.sessions.sendMessage(sessionId, workspaceId, content),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: [...queryKeys.sessions.logs(sessionId), 'all'],
			})
		},
	})
}
