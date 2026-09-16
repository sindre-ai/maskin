import type { ObjectResponse, StarToggleResponse } from '@/lib/api'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { type InfiniteData, useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { toast } from 'sonner'

/** Legacy per-workspace `localStorage` key from the pre-D5 client-only star
 *  set. We clear it opportunistically on the first `useStar` mount so the
 *  browser storage doesn't hold private bookmark state indefinitely after
 *  D5 promotes the field server-side. No backfill: the tech-spec calls a
 *  clean drop of `localStorage` — device-local sets can't sync anyway. */
const LEGACY_STAR_KEY_PREFIX = 'maskin-object-stars:'
let hasCleanedLegacyStars = false
function opportunisticallyClearLegacyStars() {
	if (hasCleanedLegacyStars) return
	hasCleanedLegacyStars = true
	if (typeof window === 'undefined') return
	try {
		const toRemove: string[] = []
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i)
			if (key?.startsWith(LEGACY_STAR_KEY_PREFIX)) toRemove.push(key)
		}
		for (const key of toRemove) localStorage.removeItem(key)
	} catch {
		// Safari private mode / disabled storage — the key can't exist here anyway.
	}
}

type ObjectListCache = ObjectResponse[]
type ObjectListInfiniteCache = InfiniteData<ObjectResponse[]>
type ObjectBoardCache = { columns: Array<{ objects: ObjectResponse[] }> }
type ObjectGraphCache = { object: ObjectResponse; connected_objects?: ObjectResponse[] }

interface Snapshot {
	list: Array<[readonly unknown[], ObjectListCache | undefined]>
	infinite: Array<[readonly unknown[], ObjectListInfiniteCache | undefined]>
	board: Array<[readonly unknown[], ObjectBoardCache | undefined]>
	detail: [readonly unknown[], ObjectResponse | undefined] | null
	graph: [readonly unknown[], ObjectGraphCache | undefined] | null
}

interface UseStarResult {
	isStarred: boolean
	isSaving: boolean
	toggle: () => void
}

/** Server-truth star for one object.
 *
 *  Reads `is_starred_by_me` off whichever object cache holds this id (detail,
 *  graph, list, infinite list) and re-reads on every cache update via a
 *  useSyncExternalStore subscription, so any consumer sees SSE-driven flips
 *  from another device without needing its own query wired up. Writes go
 *  through POST/DELETE /objects/:id/star with an optimistic patch on every
 *  cache carrying the object; onError rolls back and toasts. */
export function useStar(objectId: string): UseStarResult {
	const queryClient = useQueryClient()
	const { workspaceId } = useWorkspace()

	// Once per app session, clear the pre-D5 `localStorage` bookmark set. Fire
	// from useEffect (not a top-level import side effect) so SSR / test setup
	// don't touch `localStorage` at module load.
	const cleanedRef = useRef(false)
	useEffect(() => {
		if (cleanedRef.current) return
		cleanedRef.current = true
		opportunisticallyClearLegacyStars()
	}, [])

	const readFlag = useCallback((): boolean => {
		const detail = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(objectId))
		if (detail?.is_starred_by_me !== undefined) return detail.is_starred_by_me
		const graph = queryClient.getQueryData<ObjectGraphCache>(queryKeys.objects.graph(objectId))
		if (graph?.object.is_starred_by_me !== undefined) return graph.object.is_starred_by_me
		for (const [, cache] of queryClient.getQueriesData<ObjectListCache>({
			queryKey: queryKeys.objects.listPrefix(workspaceId),
		})) {
			const hit = cache?.find((o) => o.id === objectId)
			if (hit?.is_starred_by_me !== undefined) return hit.is_starred_by_me
		}
		for (const [, cache] of queryClient.getQueriesData<ObjectListInfiniteCache>({
			queryKey: queryKeys.objects.listInfinitePrefix(workspaceId),
		})) {
			for (const page of cache?.pages ?? []) {
				const hit = page.find((o) => o.id === objectId)
				if (hit?.is_starred_by_me !== undefined) return hit.is_starred_by_me
			}
		}
		for (const [, cache] of queryClient.getQueriesData<ObjectBoardCache>({
			queryKey: queryKeys.objects.boardPrefix(workspaceId),
		})) {
			for (const col of cache?.columns ?? []) {
				const hit = col.objects.find((o) => o.id === objectId)
				if (hit?.is_starred_by_me !== undefined) return hit.is_starred_by_me
			}
		}
		return false
	}, [queryClient, workspaceId, objectId])

	const subscribe = useCallback(
		(callback: () => void) => queryClient.getQueryCache().subscribe(() => callback()),
		[queryClient],
	)
	const isStarred = useSyncExternalStore(subscribe, readFlag, readFlag)

	const applyOptimistic = useCallback(
		(next: boolean): Snapshot => {
			const stamp = (o: ObjectResponse): ObjectResponse =>
				o.id === objectId ? { ...o, is_starred_by_me: next } : o

			const list = queryClient.getQueriesData<ObjectListCache>({
				queryKey: queryKeys.objects.listPrefix(workspaceId),
			})
			for (const [key, cache] of list) {
				if (!cache) continue
				queryClient.setQueryData<ObjectListCache>(key, cache.map(stamp))
			}

			const infinite = queryClient.getQueriesData<ObjectListInfiniteCache>({
				queryKey: queryKeys.objects.listInfinitePrefix(workspaceId),
			})
			for (const [key, cache] of infinite) {
				if (!cache) continue
				queryClient.setQueryData<ObjectListInfiniteCache>(key, {
					...cache,
					pages: cache.pages.map((page) => page.map(stamp)),
				})
			}

			const board = queryClient.getQueriesData<ObjectBoardCache>({
				queryKey: queryKeys.objects.boardPrefix(workspaceId),
			})
			for (const [key, cache] of board) {
				if (!cache) continue
				queryClient.setQueryData<ObjectBoardCache>(key, {
					...cache,
					columns: cache.columns.map((col) => ({ ...col, objects: col.objects.map(stamp) })),
				})
			}

			const detailKey = queryKeys.objects.detail(objectId)
			const cachedDetail = queryClient.getQueryData<ObjectResponse>(detailKey)
			let detail: [readonly unknown[], ObjectResponse | undefined] | null = null
			if (cachedDetail) {
				detail = [detailKey, cachedDetail]
				queryClient.setQueryData<ObjectResponse>(detailKey, stamp(cachedDetail))
			}

			const graphKey = queryKeys.objects.graph(objectId)
			const cachedGraph = queryClient.getQueryData<ObjectGraphCache>(graphKey)
			let graph: [readonly unknown[], ObjectGraphCache | undefined] | null = null
			if (cachedGraph) {
				graph = [graphKey, cachedGraph]
				queryClient.setQueryData<ObjectGraphCache>(graphKey, {
					...cachedGraph,
					object: stamp(cachedGraph.object),
					connected_objects: cachedGraph.connected_objects?.map(stamp),
				})
			}

			return { list, infinite, board, detail, graph }
		},
		[queryClient, workspaceId, objectId],
	)

	const restore = useCallback(
		(snap: Snapshot) => {
			for (const [key, cache] of snap.list) queryClient.setQueryData(key, cache)
			for (const [key, cache] of snap.infinite) queryClient.setQueryData(key, cache)
			for (const [key, cache] of snap.board) queryClient.setQueryData(key, cache)
			if (snap.detail) queryClient.setQueryData(snap.detail[0], snap.detail[1])
			if (snap.graph) queryClient.setQueryData(snap.graph[0], snap.graph[1])
		},
		[queryClient],
	)

	const mutation = useMutation<StarToggleResponse, Error, boolean, Snapshot>({
		mutationFn: (next) =>
			next ? api.objects.star(objectId, workspaceId) : api.objects.unstar(objectId, workspaceId),
		onMutate: (next) => applyOptimistic(next),
		onError: (_err, _next, ctx) => {
			if (ctx) restore(ctx)
			toast.error("Couldn't update. Try again.")
		},
		onSuccess: (data) => {
			// The server's scalar is truth — if it disagrees with the optimistic
			// guess (concurrent toggle from another device), snap to it.
			applyOptimistic(data.is_starred_by_me)
		},
	})

	const toggle = useCallback(() => {
		if (mutation.isPending) return
		mutation.mutate(!isStarred)
	}, [mutation, isStarred])

	return {
		isStarred,
		isSaving: mutation.isPending,
		toggle,
	}
}
