import { ACTIVE_STATUSES } from '@/lib/agent-status'
import { trackAgentSessionStarted } from '@/lib/analytics'
import { api } from '@/lib/api'
import type { CreateSessionInput, MessageCardAnswer, MessageQuestionAnswer } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import {
	useInfiniteQuery,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'

const ACTOR_SESSIONS_PAGE_SIZE = 5
const ACTIVE_CONVERSATION_POLL_MS = 5_000
const IDLE_CONVERSATION_POLL_MS = 30_000

export function useSession(id: string | null, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.detail(id ?? ''),
		queryFn: () => api.sessions.get(id as string, workspaceId),
		enabled: !!id,
	})
}

/**
 * Lists the 100 newest sessions for a workspace (cheap; enough for
 * pulse/active-agents consumers).
 *
 * `verbose: true` keeps today's fat SessionResponse payload during the
 * lean-list compat window — the UI's per-agent counts, activity indicators
 * and status branches all read fields (config, result, currentActivity, ...)
 * the lean shape doesn't carry. A follow-up bet migrates each consumer to
 * the lean shape and drops this flag.
 */
export function useWorkspaceSessions(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.all(workspaceId),
		queryFn: () => api.sessions.list(workspaceId, { verbose: 'true', limit: '100' }),
		enabled: !!workspaceId,
	})
}

/**
 * Per-agent session counts, cost and latest status in one grouped server query. The
 * Agents index reads this instead of paging the whole session history to count it.
 */
export function useWorkspaceSessionStats(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.stats(workspaceId),
		queryFn: () => api.sessions.stats(workspaceId),
		enabled: !!workspaceId,
	})
}

/**
 * Every session for one agent, filtered server-side by `actor_id`. Agent
 * detail must NOT derive its status or session list from the unpaged
 * workspace-wide list: that returns only the 100 newest sessions across all
 * agents, so on a busy workspace a given agent's runs fall off the page and
 * the detail view renders "No sessions yet" for an agent that is actually
 * running. Filtering at the API means one request regardless of workspace size.
 */
export function useActorSessions(actorId: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.byActorAll(workspaceId, actorId),
		queryFn: () =>
			api.sessions.list(workspaceId, { verbose: 'true', actor_id: actorId, limit: '100' }),
		enabled: !!actorId && !!workspaceId,
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
		onError: () => {
			toast.error('Failed to stop session')
		},
	})
}

/**
 * Per-session Pause / Resume (mockup 2443). Backed by `POST /sessions/:id/pause`
 * and `/resume`, which snapshot the container and restore it — distinct from the
 * agent-level pause, which stops the actor from taking new work at all.
 */
export function usePauseSession(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (sessionId: string) => api.sessions.pause(sessionId, workspaceId),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(result.id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
		},
	})
}

export function useResumeSession(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (sessionId: string) => api.sessions.resume(sessionId, workspaceId),
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
			api.sessions.list(workspaceId, {
				verbose: 'true',
				mention_object_id: objectId as string,
				limit: '100',
			}),
		enabled: !!workspaceId && !!objectId,
	})
}

export function useActiveSessionsForActor(actorId: string, workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.sessions.byActor(workspaceId, actorId),
		queryFn: () =>
			api.sessions.list(workspaceId, { verbose: 'true', actor_id: actorId, status: 'running' }),
		enabled: !!actorId && !!workspaceId,
	})
}

// Powers the conversation thread's typing indicator and failed-session
// notices. Deliberately NOT filtered to status=running — a session that
// fails before ever reaching `running` needs to be visible too, otherwise
// the chat surface shows nothing when a session fails to start. Returns the
// conversation's most recent sessions (default limit, newest first);
// useConversationActivity derives the latest session per actor and branches
// on its status from there. SSE invalidation of the broad `['sessions']`
// prefix on any session event (see sse-invalidation.ts) keeps this fresh
// without a poll interval.
export function useActiveSessionsForConversation(
	workspaceId: string,
	conversationId: string | null,
) {
	return useQuery({
		queryKey: queryKeys.sessions.byConversation(workspaceId, conversationId ?? ''),
		queryFn: () =>
			api.sessions.list(workspaceId, {
				verbose: 'true',
				conversation_id: conversationId as string,
			}),
		enabled: !!workspaceId && !!conversationId,
		// The chat transcript derives its entire live state from this list —
		// activity only renders for sessions cached as `running`. Relying on
		// SSE invalidation alone meant one dropped connection froze the
		// transcript until the user reloaded. Poll as a floor so the worst
		// case is a few seconds of lag rather than a dead UI. Fast only while a
		// session in this conversation is live (that is when the transcript is
		// changing); an idle chat falls back to a slow floor. Background tabs do
		// not poll (refetchIntervalInBackground defaults to false).
		refetchInterval: (query) =>
			query.state.data?.some((s) => ACTIVE_STATUSES.has(s.status))
				? ACTIVE_CONVERSATION_POLL_MS
				: IDLE_CONVERSATION_POLL_MS,
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
				verbose: 'true',
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

/** Sends a user turn to a running interactive session (`POST /sessions/:id/input`). */
export function useSendSessionInput(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			id,
			content,
			question_answer,
			card_answer,
		}: {
			id: string
			content: string
			question_answer?: MessageQuestionAnswer
			card_answer?: MessageCardAnswer
			/** Chat the answer lands in, so its messages refetch. */
			conversationId?: string
		}) => api.sessions.input(id, { content, question_answer, card_answer }, workspaceId),
		onSuccess: (_data, { id, conversationId }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.logs(id) })
			if (conversationId) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.conversations.messagesPrefix(conversationId),
				})
			}
		},
	})
}

/**
 * Carries on with a helper that has already ended: starts a follow-up session for the
 * same agent from the person's message. Resolves with the new session's id.
 */
export function useContinueSession(workspaceId: string, conversationId: string | null) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, content }: { id: string; content: string }) =>
			api.sessions.continue(id, content, workspaceId),
		onSuccess: () => {
			// A thread in a chat shows up through that chat's messages; a background run has
			// no chat, so its follow-up arrives through the session lists.
			if (conversationId) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.conversations.messagesPrefix(conversationId),
				})
			}
			queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all(workspaceId) })
		},
	})
}

/** The logs of every session of a thread, in order; same cache entries as `useSessionLogs`. */
export function useSessionChainLogs(
	sessionIds: string[],
	workspaceId: string,
	{ live = false }: { live?: boolean } = {},
) {
	return useQueries({
		queries: sessionIds.map((id) => ({
			queryKey: [...queryKeys.sessions.logs(id), 'all'],
			queryFn: () => api.sessions.logs(id, workspaceId, { limit: '500' }),
			// Only the newest session can still be writing.
			refetchInterval: live && id === sessionIds[sessionIds.length - 1] ? 3000 : false,
		})),
	})
}
