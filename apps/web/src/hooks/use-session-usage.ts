import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useQuery } from '@tanstack/react-query'

const DAY_MS = 86_400_000

export function pickBucket(fromMs: number, toMs: number): 'hour' | 'day' | 'week' {
	const span = (toMs - fromMs) / DAY_MS
	if (span < 2) return 'hour'
	if (span <= 90) return 'day'
	return 'week'
}

export function useSessionUsage(workspaceId: string, actorId: string, from: Date, to: Date) {
	const fromISO = from.toISOString()
	const toISO = to.toISOString()
	const bucket = pickBucket(from.getTime(), to.getTime())

	return useQuery({
		queryKey: queryKeys.sessions.usage(workspaceId, actorId, {
			from: fromISO,
			to: toISO,
			bucket,
		}),
		queryFn: () =>
			api.sessions.usage(workspaceId, {
				actor_id: actorId,
				from: fromISO,
				to: toISO,
				bucket,
			}),
		enabled: Boolean(workspaceId && actorId),
		staleTime: 30_000,
	})
}
