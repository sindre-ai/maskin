import { useActiveSessionsForConversation } from '@/hooks/use-sessions'
import { api } from '@/lib/api'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

/** The status row never sticks: it clears after this long even if nothing else did. */
export const RESUMING_MAX_MS = 60_000
const OUTPUT_POLL_MS = 2000
const ENDED_STATUSES = new Set(['completed', 'failed', 'timeout', 'user_stopped'])

export interface RelaunchWatch {
	conversationId: string
	/** The agent whose session was restarted. */
	agentId: string
	/** Every session id the conversation had when the vault was sent. The new one is not in it. */
	knownSessionIds: ReadonlySet<string>
}

/**
 * Watches a relaunch after a vault and says when the Resuming state is over: the new
 * session produced its first output line, or it ended without one. Null while still
 * waiting. The caller also clears on a chat send error, and this clears on its own
 * after RESUMING_MAX_MS, so the status row cannot stick.
 */
export function useRelaunchProgress(
	workspaceId: string,
	watch: RelaunchWatch | null,
): 'output' | 'ended' | 'timeout' | null {
	const { data: sessions } = useActiveSessionsForConversation(
		workspaceId,
		watch?.conversationId ?? null,
	)
	const next = watch
		? sessions?.find((s) => s.actorId === watch.agentId && !watch.knownSessionIds.has(s.id))
		: undefined
	const ended = !!next && ENDED_STATUSES.has(next.status)

	const { data: output } = useQuery({
		queryKey: ['relaunch-first-output', next?.id],
		queryFn: () =>
			api.sessions.logs(next?.id as string, workspaceId, { stream: 'stdout', limit: '1' }),
		enabled: !!next && !ended,
		refetchInterval: (query) => (query.state.data?.length ? false : OUTPUT_POLL_MS),
	})

	const [timedOut, setTimedOut] = useState(false)
	useEffect(() => {
		setTimedOut(false)
		if (!watch) return
		const t = setTimeout(() => setTimedOut(true), RESUMING_MAX_MS)
		return () => clearTimeout(t)
	}, [watch])

	if (!watch) return null
	if (output && output.length > 0) return 'output'
	if (ended) return 'ended'
	if (timedOut) return 'timeout'
	return null
}
