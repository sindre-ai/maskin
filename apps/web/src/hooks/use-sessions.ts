import { trackAgentSessionStarted } from '@/lib/analytics'
import { api } from '@/lib/api'
import type { CreateSessionInput } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const ACTOR_SESSIONS_PAGE_SIZE = 5

export function useSession(id: string | null, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.detail(id ?? ''),
		queryFn: () => api.sessions.get(id as string, workspaceId),
		enabled: !!id,
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
		onSuccess: (result, data) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
			queryClient.invalidateQueries({
				queryKey: queryKeys.sessions.byActor(workspaceId, data.actor_id),
			})
			trackAgentSessionStarted({
				entity_id: result.id,
				entity_type: 'session',
			})
		},
	})
}

export function useStopSession(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (sessionId: string) => api.sessions.stop(sessionId, workspaceId),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(result.id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
		},
	})
}

export function useRestartSession(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (priorSessionId: string) => api.sessions.restart(priorSessionId, workspaceId),
		onSuccess: (newSession) => {
			// The prior session row flipped to `superseded` server-side and a new
			// session row was inserted. Invalidate broadly so the timeline picks
			// up both — the per-object mention list is what renders the cards.
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(newSession.id) })
			const mentionObjectId =
				(newSession.config as Record<string, unknown> | null)?.mention &&
				typeof (newSession.config as { mention?: { object_id?: unknown } }).mention?.object_id ===
					'string'
					? (newSession.config as { mention: { object_id: string } }).mention.object_id
					: null
			if (mentionObjectId) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.sessions.byMentionObject(workspaceId, mentionObjectId),
				})
			}
		},
	})
}

export function useMentionSessionsForObject(workspaceId: string, objectId: string | null) {
	return useQuery({
		queryKey: queryKeys.sessions.byMentionObject(workspaceId, objectId ?? ''),
		queryFn: () =>
			api.sessions.list(workspaceId, { mention_object_id: objectId as string, limit: '100' }),
		enabled: !!workspaceId && !!objectId,
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

export function useActorSessionsInfinite(actorId: string, workspaceId: string) {
	return useInfiniteQuery({
		queryKey: queryKeys.sessions.byActorAllInfinite(workspaceId, actorId),
		queryFn: ({ pageParam }) =>
			api.sessions.list(workspaceId, {
				actor_id: actorId,
				limit: String(ACTOR_SESSIONS_PAGE_SIZE),
				offset: String(pageParam),
			}),
		getNextPageParam: (lastPage, allPages) =>
			lastPage.length < ACTOR_SESSIONS_PAGE_SIZE ? undefined : allPages.flat().length,
		initialPageParam: 0,
		enabled: !!actorId && !!workspaceId,
	})
}

export function useSessionLogs(
	sessionId: string | null,
	workspaceId: string,
	enabled = true,
	{ live = false }: { live?: boolean } = {},
) {
	return useQuery({
		queryKey: [...queryKeys.sessions.logs(sessionId ?? ''), 'all'],
		queryFn: () => api.sessions.logs(sessionId as string, workspaceId, { limit: '500' }),
		enabled: !!sessionId && enabled,
		refetchInterval: live ? 3000 : false,
	})
}
