import { useQueries, useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { queryKeys } from '../lib/query-keys'
import { useLoops } from './use-loops'

/**
 * Loop membership for the first `in_loop` edge on each object in a page —
 * deterministic (creation-time order via list_relationships default sort).
 *
 * Shape returned to the caller:
 *  - `data`  — `Map<objectId, { id: string; name: string }>` where `id` is the
 *    loop id and `name` is the loop's stored `name` (or `'Loop'` when the row
 *    has none — the underlying object title is nullable per `loopSummarySchema`).
 *  - `isLoading` — true while workspace loops are still loading OR any
 *    membership query is still in flight; rows can render without the chip in
 *    the meantime (D1 spec: the chip appears after the list resolves).
 *  - `isError` — true if any leg failed; render behaviour is "no chip",
 *    matching the "objects with no in_loop edge do NOT render the chip" rule.
 *
 * Implementation note. The MCP tool signature in the tech spec —
 * `list_relationships({ type: 'in_loop', source_ids: [...pageIds] })` —
 * assumes a batched relationship endpoint that doesn't exist on the internal
 * REST API (see `relationshipQuerySchema` in `packages/shared`, single
 * `source_id` / `target_id` only). Loop membership is also modelled the other
 * way round from the tech-spec sketch: `sourceId` is the loop and `targetId`
 * is the child (`apps/dev/src/routes/loops.ts` cites this explicitly), so a
 * `source_ids` filter on page ids wouldn't match anything in the first place.
 *
 * The workspace's loop count is bounded (`loopSummarySchema` is a summary of
 * ALL loops in the workspace, and the /loops page renders them in a single
 * grid), so this hook fetches `useLoops(workspaceId)` once, then fires one
 * `api.relationships.list({ source_id: loop.id, type: 'in_loop' })` per loop
 * in parallel via `useQueries`. Each per-loop query is cached under its own
 * key so revisits reuse the last snapshot instead of refetching. Membership
 * changes mid-session are picked up on the next background refetch — the
 * shape-spec's "cache staleness on in_loop membership change mid-session"
 * rabbit hole is deliberately accepted.
 */
export interface UseObjectLoopsResult {
	data: Map<string, { id: string; name: string }>
	isLoading: boolean
	isError: boolean
}

const EMPTY_LOOPS: UseObjectLoopsResult = {
	data: new Map(),
	isLoading: false,
	isError: false,
}

export function useObjectLoops(workspaceId: string, objectIds: string[]): UseObjectLoopsResult {
	const loopsQuery = useLoops(workspaceId)
	const loops = loopsQuery.data ?? []
	const membershipQueries = useQueries({
		queries: loops.map((loop) => ({
			queryKey: queryKeys.relationships.byObject(workspaceId, loop.id),
			queryFn: () =>
				api.relationships.list(workspaceId, {
					source_id: loop.id,
					type: 'in_loop',
				}),
		})),
	})

	if (objectIds.length === 0) return EMPTY_LOOPS
	if (loopsQuery.isError || membershipQueries.some((q) => q.isError)) {
		return { data: new Map(), isLoading: false, isError: true }
	}
	const isLoading = loopsQuery.isLoading || membershipQueries.some((q) => q.isLoading && !q.data)

	// Reverse-index membership: for each object in `objectIds`, keep the FIRST
	// loop edge we encounter (creation-time order). Iterating loops in the
	// order the /loops list returned them + edges in the order the
	// relationships list returned them mirrors the "creation-time order"
	// determinism the D1 spec asks for: both endpoints sort by `createdAt`
	// ASC by default.
	const wanted = new Set(objectIds)
	const byObjectId = new Map<string, { id: string; name: string }>()
	membershipQueries.forEach((q, i) => {
		const loop = loops[i]
		if (!loop || !q.data) return
		for (const edge of q.data) {
			if (!wanted.has(edge.targetId)) continue
			if (byObjectId.has(edge.targetId)) continue
			byObjectId.set(edge.targetId, {
				id: loop.id,
				name: loop.name ?? 'Loop',
			})
		}
	})

	return { data: byObjectId, isLoading, isError: false }
}
