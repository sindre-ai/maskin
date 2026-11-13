import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

export function useLoops(workspaceId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.loops.all(workspaceId),
		queryFn: () => api.loops.list(workspaceId),
		select: (data) => data.loops,
		enabled: options?.enabled,
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

// The relationships and objects endpoints return at most 100 rows a call; a flow can hold
// hundreds of items, so the readers below walk every page.
const PAGE_SIZE = 100
/** A flow past this many members is cut off, so a runaway flow cannot fan out hundreds of calls. */
const MAX_MEMBERS = 2_000

/** Every `in_loop` link from this flow: its items, and any files attached to it. */
export function useLoopMembership(workspaceId: string, loopId: string) {
	return useQuery({
		queryKey: [...queryKeys.relationships.all(workspaceId), 'loop-members', loopId],
		queryFn: async () => {
			// A fixed snapshot keeps the page order stable while the walk is under way.
			const snapshotAt = new Date().toISOString()
			const edges = new Map<string, Awaited<ReturnType<typeof api.relationships.list>>[number]>()
			for (let offset = 0; edges.size < MAX_MEMBERS; offset += PAGE_SIZE) {
				const page = await api.relationships.list(workspaceId, {
					source_id: loopId,
					type: 'in_loop',
					limit: String(PAGE_SIZE),
					offset: String(offset),
					order: 'asc',
					snapshot_at: snapshotAt,
				})
				for (const edge of page) edges.set(edge.id, edge)
				if (page.length < PAGE_SIZE) break
			}
			const all = [...edges.values()]
			return {
				itemIds: all.filter((e) => e.targetType !== 'file').map((e) => e.targetId),
				fileIds: all.filter((e) => e.targetType === 'file').map((e) => e.targetId),
			}
		},
		enabled: !!workspaceId && !!loopId,
	})
}

/** The items with these ids, fetched a page at a time. */
export function useObjectsByIds(workspaceId: string, ids: readonly string[]) {
	return useQuery({
		queryKey: [...queryKeys.objects.all(workspaceId), 'by-ids', [...ids].sort().join(',')],
		queryFn: async () => {
			const chunks: string[][] = []
			for (let i = 0; i < ids.length; i += PAGE_SIZE) chunks.push(ids.slice(i, i + PAGE_SIZE))
			const pages = await Promise.all(
				chunks.map((chunk) =>
					api.objects.list(workspaceId, { ids: chunk.join(','), limit: String(PAGE_SIZE) }),
				),
			)
			return pages.flat()
		},
		enabled: !!workspaceId && ids.length > 0,
	})
}
