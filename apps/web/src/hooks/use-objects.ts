import type { createObjectSchema, updateObjectSchema } from '@maskin/shared'
import {
	type InfiniteData,
	keepPreviousData,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from '@tanstack/react-query'
import type { RowSelectionState } from '@tanstack/react-table'
import { type Dispatch, type SetStateAction, useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { z } from 'zod'
import {
	type ObjectMutationType,
	trackBetArchived,
	trackBetCreated,
	trackBetStatusChanged,
	trackObjectUpdated,
} from '../lib/analytics'
import type {
	BulkUpdateObjectsInput,
	BulkUpdateObjectsResponse,
	ChatCardRef,
	MigrateObjectTypeInput,
	ObjectResponse,
} from '../lib/api'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'

type CreateObjectInput = z.input<typeof createObjectSchema>
// `chat` rides along on a status change made from a chat card (see LinkedObjectCard).
type UpdateObjectInput = z.input<typeof updateObjectSchema> & { chat?: ChatCardRef }

// Derives the `object_updated` event's `mutation_type` from a patch shape.
// A patch that touches `status` is classified as a status change; everything
// else (title, content, metadata, driver) rolls up to 'field'. The bet's
// HogQL groups per-session counts regardless, so the finer split is diagnostic
// — it lets the Analyst slice status changes vs. field edits without a schema
// change if the bet ever comes back to life.
function deriveMutationType(patch: {
	status?: unknown
	title?: unknown
	content?: unknown
	metadata?: unknown
	driver?: unknown
}): Exclude<ObjectMutationType, 'delete'> {
	return patch.status !== undefined ? 'status' : 'field'
}

export function useObjects(
	workspaceId: string,
	filters?: Record<string, string>,
	options?: { enabled?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.objects.list(workspaceId, filters),
		queryFn: () => api.objects.list(workspaceId, filters),
		enabled: options?.enabled ?? true,
	})
}

export function useObject(id: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.objects.detail(id),
		queryFn: () => api.objects.get(id),
		enabled: !!id && (options?.enabled ?? true),
	})
}

/**
 * A person's yes to sending a drafted object exactly as it reads. The hash is the preview's
 * `content_hash`, so a draft that changed since it was drawn is refused. The object is
 * re-read afterwards so its card shows the approval.
 */
export function useApproveObject() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({
			id,
			contentHash,
			chat,
		}: { id: string; contentHash?: string; chat?: ChatCardRef }) =>
			api.objects.approve(id, contentHash, chat),
		onSuccess: (data, { id }) => {
			// The card reads Approved straight away instead of offering the button again
			// until the refetch lands.
			queryClient.setQueryData<ObjectResponse>(queryKeys.objects.detail(id), (cached) =>
				cached ? { ...cached, preview: data.preview } : cached,
			)
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
		},
	})
}

// Shared search engine for the command palette's active-query results and the
// /search view — one server-side ranking so both surfaces show the same order.
// `enabled` is driven by the trimmed query: no request fires for an empty
// query (the server schema requires `q`).
export function useSearchObjects(
	workspaceId: string,
	params: { q: string; type?: string; status?: string; limit?: number },
	options?: { enabled?: boolean; keepPrevious?: boolean },
) {
	const q = params.q.trim()
	const normalized = { q, type: params.type, status: params.status, limit: params.limit }
	return useQuery({
		queryKey: queryKeys.objects.search(workspaceId, normalized),
		queryFn: () =>
			api.objects.search(
				workspaceId,
				Object.fromEntries(
					Object.entries(normalized).filter(([, v]) => v !== undefined && v !== ''),
				) as Record<string, string>,
			),
		enabled: (options?.enabled ?? true) && q.length >= 1,
		placeholderData: options?.keepPrevious ? keepPreviousData : undefined,
	})
}

// Exact totals for the Objects page. Every number the page shows — tab counts,
// group headers, filter chips — comes from here, never from counting whichever
// rows have loaded, so nothing changes under the user as they scroll.
export function useObjectFacets(workspaceId: string, params: Record<string, string>) {
	return useQuery({
		queryKey: queryKeys.objects.facets(workspaceId, params),
		queryFn: () => api.objects.facets(workspaceId, params),
		enabled: !!workspaceId,
		placeholderData: keepPreviousData,
	})
}

/** Rows fetched per group page. */
export const GROUP_PAGE_SIZE = 25
/** Groups whose rows are fetched up front; the rest follow as the list scrolls. */
const INITIAL_GROUP_BATCH = 12

export interface GroupedObjectsGroup {
	/** The server's spelling: `''` is the group of rows with no value. */
	value: string
	total: number
	loaded: number
}

interface GroupedObjectsArgs {
	workspaceId: string
	/** Filter params shared with the flat list (no paging, no group). */
	params: Record<string, string>
	groupBy: string
	/** The group headers, with exact totals, from `useObjectFacets`. */
	groups: ReadonlyArray<{ value: string; total: number }> | undefined
	/** Collapsed groups are not fetched. */
	isGroupOpen: (value: string) => boolean
	enabled: boolean
}

// Rows for the grouped list. The headers and totals are already known, so each
// group only fetches its own rows, a page at a time — "Show more" in one group
// never touches another, and a group's total never changes after it first
// shows. Groups fetch lazily in batches so a date axis with hundreds of groups
// stays a handful of requests.
export function useGroupedObjects({
	workspaceId,
	params,
	groupBy,
	groups,
	isGroupOpen,
	enabled,
}: GroupedObjectsArgs) {
	const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
	const scopeKey = JSON.stringify({ params, groupBy })
	// Paging state belongs to one filter+axis scope; a new scope starts from the top.
	const [state, setState] = useState<{
		scopeKey: string
		pages: Record<string, number>
		batches: number
	}>({ scopeKey, pages: {}, batches: 1 })
	const current = state.scopeKey === scopeKey ? state : { scopeKey, pages: {}, batches: 1 }

	const groupList = useMemo(() => groups ?? [], [groups])
	const fetchedGroupCount = current.batches * INITIAL_GROUP_BATCH
	const plan = useMemo(() => {
		const entries: Array<{ value: string; page: number }> = []
		for (const group of groupList.slice(0, fetchedGroupCount)) {
			if (!isGroupOpen(group.value) || group.total === 0) continue
			const pages = current.pages[group.value] ?? 1
			for (let page = 0; page < pages; page++) entries.push({ value: group.value, page })
		}
		return entries
	}, [groupList, fetchedGroupCount, isGroupOpen, current.pages])

	const results = useQueries({
		queries: plan.map(({ value, page }) => {
			const query = {
				...params,
				group_by: groupBy,
				group_value: value,
				tz,
				limit: String(GROUP_PAGE_SIZE),
				offset: String(page * GROUP_PAGE_SIZE),
			}
			return {
				queryKey: queryKeys.objects.groupPage(workspaceId, query),
				queryFn: () => api.objects.list(workspaceId, query),
				enabled: enabled && !!workspaceId,
			}
		}),
	})

	const { rows, loadedByGroup, loadingGroups, firstError, isLoading } = useMemo(() => {
		const rowsByGroup = new Map<string, ObjectResponse[]>()
		const loading = new Set<string>()
		let error: Error | null = null
		let initialLoading = false
		for (const [index, result] of results.entries()) {
			const entry = plan[index]
			if (!entry) continue
			if (result.data) {
				const bucket = rowsByGroup.get(entry.value) ?? []
				bucket.push(...result.data)
				rowsByGroup.set(entry.value, bucket)
			}
			if (result.isFetching && entry.page > 0) loading.add(entry.value)
			if (result.isLoading) {
				if (entry.page === 0) initialLoading = true
				else loading.add(entry.value)
			}
			if (result.error && !error) error = result.error as Error
		}
		const ordered: ObjectResponse[] = []
		const loaded = new Map<string, number>()
		for (const group of groupList) {
			const bucket = rowsByGroup.get(group.value) ?? []
			loaded.set(group.value, bucket.length)
			ordered.push(...bucket)
		}
		return {
			rows: ordered,
			loadedByGroup: loaded,
			loadingGroups: loading,
			firstError: error,
			isLoading: initialLoading,
		}
	}, [results, plan, groupList])

	const loadMoreInGroup = useCallback(
		(value: string) =>
			setState((prev) => {
				const base = prev.scopeKey === scopeKey ? prev : { scopeKey, pages: {}, batches: 1 }
				return {
					...base,
					pages: { ...base.pages, [value]: (base.pages[value] ?? 1) + 1 },
				}
			}),
		[scopeKey],
	)
	const loadMoreGroups = useCallback(
		() =>
			setState((prev) => {
				const base = prev.scopeKey === scopeKey ? prev : { scopeKey, pages: {}, batches: 1 }
				return { ...base, batches: base.batches + 1 }
			}),
		[scopeKey],
	)

	return {
		rows,
		groups: groupList.map<GroupedObjectsGroup>((group) => ({
			...group,
			loaded: loadedByGroup.get(group.value) ?? 0,
		})),
		loadingGroups,
		hasMoreGroups: groupList.length > fetchedGroupCount,
		loadMoreInGroup,
		loadMoreGroups,
		isLoading,
		error: firstError,
	}
}

export function useObjectGraph(
	workspaceId: string,
	id: string,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: queryKeys.objects.graph(id),
		queryFn: () => api.objects.graph(id, workspaceId),
		enabled: enabled && !!id && !!workspaceId,
	})
}

// Powers the "Referenced by N contexts/week" chip on the knowledge doc
// header. DoD is happy with async freshness up to 5 minutes — a longer stale
// window plus the SSE-driven cache invalidation that fires on any new
// `workspace_knowledge_referenced` event keeps this cheap without stalling
// the chip after a real cite.
export function useKnowledgeReferences(
	workspaceId: string,
	id: string,
	{ enabled = true }: { enabled?: boolean } = {},
) {
	return useQuery({
		queryKey: queryKeys.objects.references(id),
		queryFn: () => api.objects.references(id, workspaceId),
		enabled: enabled && !!id && !!workspaceId,
		staleTime: 5 * 60 * 1000,
	})
}

export function useCreateObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (data: CreateObjectInput) => api.objects.create(workspaceId, data),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.objects.detail(data.id), data)
			if (data.type === 'bet') {
				trackBetCreated({ entity_id: data.id, entity_type: 'bet' })
			}
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
		onMutate: ({ id, data }) => {
			const cached = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(id))
			// Archiving is the one status transition where the row must disappear
			// from default reads (T3's `include_archived=false` gate) instead of
			// just changing colour. Optimistically drop it from the list caches so
			// the row is gone before the server response settles; onSettled's
			// invalidation will re-hydrate either way.
			const listSnapshots =
				data.status === 'archived'
					? optimisticallyHideArchivedRow(queryClient, workspaceId, id)
					: null
			return { prevStatus: cached?.status ?? null, type: cached?.type ?? null, listSnapshots }
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.listSnapshots) restoreListSnapshots(queryClient, ctx.listSnapshots)
		},
		onSuccess: (data, variables, ctx) => {
			const nextStatus = variables.data.status
			if (
				nextStatus &&
				ctx?.prevStatus &&
				nextStatus !== ctx.prevStatus &&
				(data.type === 'bet' || data.type === 'task' || data.type === 'insight')
			) {
				trackBetStatusChanged({
					entity_id: data.id,
					entity_type: data.type,
					from: ctx.prevStatus,
					to: nextStatus,
				})
			}
			trackObjectUpdated({
				object_id: data.id,
				mutation_type: deriveMutationType(variables.data),
				via: 'single',
				bulk_batch_size: 1,
			})
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			// A loop is an object, and `useLoop` reads the loop out of the /loops
			// list response — without this a rename or an edit to the loop's
			// promise wouldn't reach the loop pages until the list refetched.
			queryClient.invalidateQueries({ queryKey: queryKeys.loops.all(workspaceId) })
		},
	})
}

interface ListSnapshots {
	flat: Array<[readonly unknown[], ObjectResponse[] | undefined]>
	infinite: Array<[readonly unknown[], InfiniteData<ObjectResponse[]> | undefined]>
}

function optimisticallyHideArchivedRow(
	queryClient: ReturnType<typeof useQueryClient>,
	workspaceId: string,
	id: string,
): ListSnapshots {
	const flat = queryClient.getQueriesData<ObjectResponse[]>({
		queryKey: queryKeys.objects.listPrefix(workspaceId),
	})
	for (const [key, cache] of flat) {
		if (!cache) continue
		queryClient.setQueryData<ObjectResponse[]>(
			key,
			cache.filter((obj) => obj.id !== id),
		)
	}
	const infinite = queryClient.getQueriesData<InfiniteData<ObjectResponse[]>>({
		queryKey: queryKeys.objects.listInfinitePrefix(workspaceId),
	})
	for (const [key, cache] of infinite) {
		if (!cache) continue
		queryClient.setQueryData<InfiniteData<ObjectResponse[]>>(key, {
			...cache,
			pages: cache.pages.map((page) => page.filter((obj) => obj.id !== id)),
		})
	}
	return { flat, infinite }
}

function restoreListSnapshots(
	queryClient: ReturnType<typeof useQueryClient>,
	snapshots: ListSnapshots,
) {
	for (const [key, cache] of snapshots.flat) queryClient.setQueryData(key, cache)
	for (const [key, cache] of snapshots.infinite) queryClient.setQueryData(key, cache)
}

type ObjectListCache = ObjectResponse[]
type ObjectListInfiniteCache = InfiniteData<ObjectResponse[]>

interface BulkUpdateContext {
	listSnapshots: Array<[readonly unknown[], ObjectListCache | undefined]>
	listInfiniteSnapshots: Array<[readonly unknown[], ObjectListInfiniteCache | undefined]>
	detailSnapshots: Array<[readonly unknown[], ObjectResponse | undefined]>
}

// Optimistically apply a patch to every object whose id appears in `ids`.
// Touches both the flat list cache and the page-shaped infinite cache, plus
// any open detail caches, so the data-table re-renders without waiting on the
// server response. Snapshots are returned so onError can rollback.
function applyOptimisticBulkPatch(
	queryClient: ReturnType<typeof useQueryClient>,
	workspaceId: string,
	ids: string[],
	patch: BulkUpdateObjectsInput['patch'],
): BulkUpdateContext {
	const idSet = new Set(ids)
	const stamped = new Date().toISOString()
	const merge = (obj: ObjectResponse): ObjectResponse => {
		if (!idSet.has(obj.id)) return obj
		const next: ObjectResponse = { ...obj, updatedAt: stamped }
		if (patch.status !== undefined) next.status = patch.status
		if (patch.driver !== undefined) next.driver = patch.driver
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
			pages: cache.pages.map((page) => page.map(merge)),
		})
	}

	const detailSnapshots: Array<[readonly unknown[], ObjectResponse | undefined]> = []
	for (const id of ids) {
		const key = queryKeys.objects.detail(id)
		const cached = queryClient.getQueryData<ObjectResponse>(key)
		if (cached) {
			detailSnapshots.push([key, cached])
			queryClient.setQueryData<ObjectResponse>(key, merge(cached))
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
		onMutate: async ({ ids, patch }) => {
			await queryClient.cancelQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			return applyOptimisticBulkPatch(queryClient, workspaceId, ids, patch)
		},
		onError: (_err, _vars, ctx) => {
			if (ctx) rollbackBulkPatch(queryClient, ctx)
		},
		onSuccess: (data, { ids, patch }) => {
			const mutationType = deriveMutationType(patch)
			const bulkBatchSize = ids.length
			for (const result of data.results) {
				if (!result.ok) continue
				trackObjectUpdated({
					object_id: result.id,
					mutation_type: mutationType,
					via: 'bulk',
					bulk_batch_size: bulkBatchSize,
				})
			}
		},
		onSettled: (data, _err, { ids }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
			// On network failure (no data) we don't know which rows changed, so
			// fall back to invalidating every requested id's detail cache. On a
			// 200, only invalidate details for ids the server reported ok=true.
			const idsToInvalidate = data ? data.results.filter((r) => r.ok).map((r) => r.id) : ids
			for (const id of idsToInvalidate) {
				queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			}
		},
	})
}

export interface BulkOperationResponse {
	results: Array<{ id: string; ok: boolean; error?: string }>
}

// Shared toast + selection-retention logic for bulk object mutations (status
// change, owner change, delete). Guards against a malformed `results` shape
// so an API contract drift can't throw inside a query-observer onSuccess
// callback — TanStack Query swallows that exception (`void Promise.reject(e)`)
// with no user-visible signal, leaving the toast unshown and the selection
// un-trimmed despite the mutation having actually completed.
export function useBulkResultHandlers(
	clearSelection: () => void,
	setRowSelection: Dispatch<SetStateAction<RowSelectionState>>,
) {
	const reportBulkResult = useCallback(
		(response: BulkOperationResponse, total: number, verb: 'updated' | 'deleted') => {
			if (!Array.isArray(response?.results)) {
				toast.error(`Failed to ${verb === 'deleted' ? 'delete' : 'update'} objects`)
				return
			}
			const okCount = response.results.filter((r) => r.ok).length
			const failed = total - okCount
			if (failed === 0) {
				toast.success(`${okCount} object${okCount === 1 ? '' : 's'} ${verb}`)
				clearSelection()
			} else {
				const firstError = response.results.find((r) => !r.ok)?.error
				toast.error(`${okCount} of ${total} ${verb}; ${failed} failed`, {
					description: firstError,
				})
			}
		},
		[clearSelection],
	)

	const retainOnlyFailed = useCallback(
		(response: BulkOperationResponse) => {
			if (!Array.isArray(response?.results)) return
			const failedIds = new Set(response.results.filter((r) => !r.ok).map((r) => r.id))
			if (failedIds.size === 0) return
			setRowSelection((prev) => {
				const next: RowSelectionState = {}
				for (const id of Object.keys(prev)) {
					if (failedIds.has(id)) next[id] = prev[id] as boolean
				}
				return next
			})
		},
		[setRowSelection],
	)

	return { reportBulkResult, retainOnlyFailed }
}

// Stamp / unstamp the "Verified" chip on a Knowledge Author write. Server-side
// this is a scoped write on `metadata.verified_by` + `metadata.verified_at`
// wrapped with a dedicated `verified` / `unverified` timeline event; server
// enforces the "human admin/owner only" rule so the mutation is safe to
// surface behind a client-side visibility guard.
export function useVerifyObject(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, verified }: { id: string; verified: boolean }) =>
			api.objects.verify(id, verified),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.objects.detail(data.id), data)
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
		},
	})
}

// Roll back a single Knowledge Author write on a knowledge object. Server
// re-verifies the KA identity, the 7-day window, and the caller's role, so
// the mutation is safe to expose behind the client-side visibility guard.
// Invalidates detail + graph + list on settle so the SSE-refreshed timeline
// picks up the reversal + reversal event row without a manual refresh.
export function useUndoKnowledgeWrite(workspaceId: string) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: ({ id, eventId }: { id: string; eventId: number }) =>
			api.objects.undoWrite(id, eventId),
		onSuccess: (data) => {
			queryClient.setQueryData(queryKeys.objects.detail(data.id), data)
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.graph(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
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
		onMutate: (id) => {
			const cached = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(id))
			return { type: cached?.type ?? null, id }
		},
		onSuccess: (_data, _variables, ctx) => {
			toast.success('Object deleted')
			if (ctx?.type === 'bet') {
				trackBetArchived({ entity_id: ctx.id, entity_type: 'bet' })
			}
			if (ctx?.id) {
				trackObjectUpdated({
					object_id: ctx.id,
					mutation_type: 'delete',
					via: 'single',
					bulk_batch_size: 1,
				})
			}
		},
		onError: () => {
			toast.error('Failed to delete object')
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}
