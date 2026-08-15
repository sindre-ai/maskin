import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useLoops(workspaceId: string) {
	return useQuery({
		queryKey: queryKeys.loops.all(workspaceId),
		queryFn: () => api.loops.list(workspaceId),
		select: (data) => data.loops,
	})
}

export function useLoop(id: string, workspaceId: string) {
	const { data: loops, ...rest } = useLoops(workspaceId)
	return {
		...rest,
		data: loops?.find((l) => l.id === id),
	}
}

export function useLoopActivity(
	loopId: string,
	workspaceId: string,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: queryKeys.loops.activity(workspaceId, loopId),
		queryFn: () => api.loops.activity(loopId, workspaceId),
		enabled: enabled && !!loopId,
		select: (data) => data.events,
	})
}
