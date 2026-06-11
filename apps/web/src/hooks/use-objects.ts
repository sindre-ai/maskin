import type { createObjectSchema, updateObjectSchema } from '@maskin/shared'
import { type InfiniteData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { z } from 'zod'
import type {
	BulkDeleteObjectsInput,
	BulkUpdateObjectsInput,
	BulkUpdateObjectsResponse,
	BulkUpdatePatch,
	MigrateObjectTypeInput,
	ObjectResponse,
	ObjectsFilterInput,
} from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

type CreateObjectInput = z.input<typeof createObjectSchema>
type UpdateObjectInput = z.input<typeof updateObjectSchema>

export function useObjects(workspaceId: string, filters?: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.objects.list(workspaceId, filters),
		queryFn: () => api.objects.list(workspaceId, filters),
	})
}

export function useObject(id: string) {
	return useQuery({
		queryKey: queryKeys.objects.detail(id),
		queryFn: () => api.objects.get(id),
		enabled: !!id,
	})
}

export function useObjectGraph(workspaceId: string, id: string) {
	return useQuery({
		queryKey: queryKeys.objects.graph(id),
		queryFn: () => api.objects.graph(id, workspaceId),
		enabled: !!id && !!workspaceId,
	})
}

export function useCreateObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateObjectInput) => api.objects.create(workspaceId, data),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.objects.detail(data.id), data)
		},
		onSettled: (_data, _err, variables) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			if (variables.type === 'bet') {
				queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			}
		},
	})
}

export function useUpdateObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateObjectInput }) =>
			api.objects.update(id, data),
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}

type ObjectListCache = ObjectResponse[]
/** Each page of the listInfinite cache carries totalCount in addition to the
 * row items — the virtualizer reads totalCount to drive the "select all N
 * matching this filter" affordance. Older callers that only need the rows
 * walk `pages[i].items`. */
export interface ObjectListInfinitePage {
	items: ObjectResponse[]
	totalCount: number | null
}
type ObjectListInfiniteCache = InfiniteData<ObjectListInfinitePage>

interface BulkUpdateContext {
	listSnapshots: Array<[readonly unknown[], ObjectListCache | undefined]>
	listInfiniteSnapshots: Array<[readonly unknown[], ObjectListInfiniteCache | undefined]>
	detailSnapshots: Array<[readonly unknown[], ObjectResponse | undefined]>
}

// Mirror of the server-side row-selection predicate. Kept in sync with
// buildObjectsWhere on the server so the optimistic patch only touches loaded
// rows that *would* match the filter — rows the user never scrolled to stay
// untouched in cache until the server's eventual `onSettled` invalidate.
// Known divergence: the `q` predicate here concatenates title+content before
// matching, while the server ORs them independently. Optimistic UI may briefly
// mispredict — server is source of truth.
function matchesObjectsFilter(obj: ObjectResponse, filter: ObjectsFilterInput): boolean {
	if (filter.type && obj.type !== filter.type) return false
	if (filter.status) {
		const statuses = filter.status.split(',').filter(Boolean)
		if (statuses.length > 0 && !statuses.includes(obj.status)) return false
	}
	if (filter.owner) {
		const owners = filter.owner.split(',').filter(Boolean)
		if (owners.length > 0 && (!obj.owner || !owners.includes(obj.owner))) return false
	}
	if (filter.ids) {
		const idList = filter.ids.split(',').filter(Boolean)
		if (idList.length > 0 && !idList.includes(obj.id)) return false
	}
	if (filter.q) {
		const needle = filter.q.toLowerCase()
		const hay = `${obj.title ?? ''} ${obj.content ?? ''}`.toLowerCase()
		if (!hay.includes(needle)) return false
	}
	return true
}

// Optimistically apply a patch to every object matching the selection scope.
// Touches both the flat list cache and the page-shaped infinite cache, plus
// any open detail caches, so the data-table re-renders without waiting on the
// server response. Snapshots are returned so onError can rollback.
//
// In `ids` scope we patch exactly the listed ids. In `filter` scope we re-run
// the filter predicate on every loaded row — this is the virtualizer-aware
// path: rows the user never scrolled to stay untouched in cache and reconcile
// on the server's response. Detail caches are only invalidated for ids the
// server reports `ok: true` (see onSettled below).
function applyOptimisticBulkPatch(
	queryClient: ReturnType<typeof useQueryClient>,
	workspaceId: string,
	input: BulkUpdateObjectsInput,
): BulkUpdateContext {
	const stamped = new Date().toISOString()
	const shouldPatch = input.scope === 'ids' ? (id: string) => new Set(input.ids).has(id) : undefined
	const filterPredicate =
		input.scope === 'filter'
			? (obj: ObjectResponse) => matchesObjectsFilter(obj, input.filter)
			: undefined

	const patch = input.patch
	const merge = (obj: ObjectResponse): ObjectResponse => {
		const hit =
			input.scope === 'ids'
				? (shouldPatch as (id: string) => boolean)(obj.id)
				: (filterPredicate as (o: ObjectResponse) => boolean)(obj)
		if (!hit) return obj
		const next: ObjectResponse = { ...obj, updatedAt: stamped }
		if (patch.status !== undefined) next.status = patch.status
		if (patch.owner !== undefined) next.owner = patch.owner
		if (patch.metadata !== undefined) {
			next.metadata = { ...(obj.metadata ?? {}), ...patch.metadata }
		}
		return next
	}

	const listSnapshots = queryClient.getQueriesData<ObjectListCache>({
		queryKey: queryKeys.objects.listPrefix(workspaceId),
	})
	for (const [key, cache] of listSnapshots) {
		if (!cache) continue
		queryClient.setQueryData<ObjectListCache>(key, cache.map(merge))
	}

	const listInfiniteSnapshots = queryClient.getQueriesData<ObjectListInfiniteCache>({
		queryKey: queryKeys.objects.listInfinitePrefix(workspaceId),
	})
	for (const [key, cache] of listInfiniteSnapshots) {
		if (!cache) continue
		queryClient.setQueryData<ObjectListInfiniteCache>(key, {
			...cache,
			pages: cache.pages.map((page) => ({
				items: page.items.map(merge),
				totalCount: page.totalCount,
			})),
		})
	}

	// In `ids` scope we know exactly which detail caches to flip. In `filter`
	// scope we'd have to walk every open detail cache — skip it; the server's
	// onSettled invalidate covers detail rehydration without the cost.
	const detailSnapshots: Array<[readonly unknown[], ObjectResponse | undefined]> = []
	if (input.scope === 'ids') {
		for (const id of input.ids) {
			const key = queryKeys.objects.detail(id)
			const cached = queryClient.getQueryData<ObjectResponse>(key)
			if (cached) {
				detailSnapshots.push([key, cached])
				queryClient.setQueryData<ObjectResponse>(key, merge(cached))
			}
		}
	}

	return { listSnapshots, listInfiniteSnapshots, detailSnapshots }
}

function rollbackBulkPatch(queryClient: ReturnType<typeof useQueryClient>, ctx: BulkUpdateContext) {
	for (const [key, cache] of ctx.listSnapshots) {
		queryClient.setQueryData(key, cache)
	}
	for (const [key, cache] of ctx.listInfiniteSnapshots) {
		queryClient.setQueryData(key, cache)
	}
	for (const [key, cache] of ctx.detailSnapshots) {
		queryClient.setQueryData(key, cache)
	}
}

export function useBulkUpdateObjects(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<BulkUpdateObjectsResponse, Error, BulkUpdateObjectsInput, BulkUpdateContext>({
		mutationFn: (body) => api.objects.bulkUpdate(workspaceId, body),
		onMutate: async (input) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			return applyOptimisticBulkPatch(queryClient, workspaceId, input)
		},
		onError: (_err, _vars, ctx) => {
			if (ctx) rollbackBulkPatch(queryClient, ctx)
		},
		onSettled: (data, _err, input) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			// On network failure (no data) we don't know which rows changed, so
			// fall back to invalidating every requested id's detail cache. On a
			// 200, only invalidate details for ids the server reported ok=true.
			const failureFallback = input.scope === 'ids' ? input.ids : []
			const idsToInvalidate = data
				? data.results.filter((r) => r.ok).map((r) => r.id)
				: failureFallback
			for (const id of idsToInvalidate) {
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			}
		},
	})
}

/**
 * Convenience wrapper for the most common loaded-rows call site — keeps the
 * old `{ ids, patch }` shape so callers that pre-date the two-scope contract
 * don't have to thread `scope: 'ids'` through. Filter-scoped callers should
 * use `useBulkUpdateObjects` directly.
 */
export function useBulkUpdateLoadedObjects(workspaceId: string) {
	const mutation = useBulkUpdateObjects(workspaceId)
	return {
		...mutation,
		mutate: (
			vars: { ids: string[]; patch: BulkUpdatePatch },
			options?: Parameters<typeof mutation.mutate>[1],
		) => mutation.mutate({ scope: 'ids', ids: vars.ids, patch: vars.patch }, options),
		mutateAsync: (vars: { ids: string[]; patch: BulkUpdatePatch }) =>
			mutation.mutateAsync({ scope: 'ids', ids: vars.ids, patch: vars.patch }),
	}
}

export function useBulkDeleteObjects(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation<BulkUpdateObjectsResponse, Error, BulkDeleteObjectsInput>({
		mutationFn: (body) => api.objects.bulkDelete(workspaceId, body),
		onSettled: (data, _err, input) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			// Drop detail caches for ids the server actually deleted so a router
			// nav to the gone object doesn't render stale data. On network
			// failure (no data) fall back to ids scope's known list; filter
			// scope can't enumerate offline so we skip.
			const idsToInvalidate = data
				? data.results.filter((r) => r.ok).map((r) => r.id)
				: input.scope === 'ids'
					? input.ids
					: []
			for (const id of idsToInvalidate) {
				queryClient.removeQueries({ queryKey: queryKeys.objects.detail(id) })
			}
		},
	})
}

export function useMigrateObjectType(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: MigrateObjectTypeInput) => api.objects.migrateType(workspaceId, data),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}

export function useDeleteObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (id: string) => api.objects.delete(id),
		onSuccess: () => {
			toast.success('Object deleted')
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}
