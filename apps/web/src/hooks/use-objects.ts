import type { createObjectSchema, updateObjectSchema } from '@maskin/shared'
import { type InfiniteData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RowSelectionState } from '@tanstack/react-table'
import { type Dispatch, type SetStateAction, useCallback } from 'react'
import { toast } from 'sonner'
import type { z } from 'zod'
import { trackBetArchived, trackBetCreated, trackBetStatusChanged } from '../lib/analytics'
import type {
	BulkUpdateObjectsInput,
	BulkUpdateObjectsResponse,
	MigrateObjectTypeInput,
	ObjectResponse,
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

export function useObject(id: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.objects.detail(id),
		queryFn: () => api.objects.get(id),
		enabled: !!id && (options?.enabled ?? true),
	})
}

export function useObjectGraph(workspaceId: string, id: string) {
	return useQuery({
		queryKey: queryKeys.objects.graph(id),
		queryFn: () => api.objects.graph(id, workspaceId),
		enabled: !!id && !!workspaceId,
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
		onMutate: ({ id }) => {
			const cached = queryClient.getQueryData<ObjectResponse>(queryKeys.objects.detail(id))
			return { prevStatus: cached?.status ?? null, type: cached?.type ?? null }
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
		},
		onSettled: (_data, _err, { id }) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.detail(id) })
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
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
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.objects.all(workspaceId) })
			queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
		},
	})
}
