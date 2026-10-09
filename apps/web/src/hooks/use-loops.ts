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

// The vertical-story renderer's data feed — one row per trigger in the
// loop's `metadata.trigger_ids`, with the Loops v4 (D6a) hands-off +
// escalates fields, resolved actor names and per-viewer waiting-on-viewer
// counts pre-computed on the server. `enabled` lets a caller mount the
// hook conditionally on the `loops-v4-polish.step_flow` flag, so a
// flag-off session pays no extra request.
export function useLoopSteps(
	loopId: string,
	workspaceId: string,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: queryKeys.loops.steps(workspaceId, loopId),
		queryFn: () => api.loops.steps(loopId, workspaceId),
		enabled: enabled && !!loopId,
		select: (data) => data.steps,
	})
}
