import { trackAgentSessionStarted } from '@/lib/analytics'
import { api } from '@/lib/api'
import type { CreateSessionInput, SessionResponse } from '@/lib/api'
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

/**
 * Lists sessions for a workspace. By default fetches a single 100-row page
 * (cheap; enough for pulse/active-agents consumers). Pass `paged: true` to
 * page past the API's 100-row clamp (sessionQuerySchema) until a short page —
 * the Agents index's per-agent counts and latest-session status are
 * load-bearing on full history.
 */
export function useWorkspaceSessions(
	workspaceId: string,
	{ paged = false }: { paged?: boolean } = {},
) {
	return useQuery({
		queryKey: paged
			? [...queryKeys.sessions.all(workspaceId), 'paged']
			: queryKeys.sessions.all(workspaceId),
		queryFn: async () => {
			if (!paged) return api.sessions.list(workspaceId, { limit: '100' })
			const pageSize = 100
			const all: SessionResponse[] = []
			let offset = 0
			for (;;) {
				const page = await api.sessions.list(workspaceId, {
					limit: String(pageSize),
					offset: String(offset),
				})
				all.push(...page)
				if (page.length < pageSize) return all
				offset += page.length
			}
		},
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
