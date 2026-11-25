// The Agents and Flows pages' search order: one call to GET /api/search for a single type while
// words are typed, so a name match ranks above a description match the way it does everywhere
// else. The page keeps its own word filter for which rows show; this only says in what order.

import {
	SEARCH_QUERY_DEBOUNCE_MS,
	useDebouncedValue,
	useSearchQuery,
} from '@/hooks/use-search-query'
import { STATUS_GROUP_KEYS } from '@maskin/shared'
import { useMemo } from 'react'

// A search hides archived rows unless Archived is among the statuses asked for. The list pages
// show every row, so all five groups are asked for.
const EVERY_STATUS: string[] = [...STATUS_GROUP_KEYS]

/**
 * Place of each matching row in the server's order (0 is the best match), or null when nothing
 * is typed or the answer has not arrived: the page then keeps the Display order.
 */
export function usePageSearchRank(
	workspaceId: string,
	text: string,
	type: 'agent' | 'loop',
): ReadonlyMap<string, number> | null {
	const typed = text.trim()
	const debounced = useDebouncedValue(typed, SEARCH_QUERY_DEBOUNCE_MS)
	const query = useSearchQuery(
		workspaceId,
		{ text: debounced, types: [type], statuses: EVERY_STATUS, updated: '', sort: 'rel' },
		typed !== '',
	)
	const results = query.data?.results
	return useMemo(() => {
		if (typed === '' || !results) return null
		return new Map(results.map((row, place) => [row.id, place]))
	}, [typed, results])
}

/** The rows in the server's order; a row it did not rank (a typo or a tag hit) keeps its place after them. */
export function sortByRank<T>(
	rows: T[],
	rank: ReadonlyMap<string, number> | null,
	idOf: (row: T) => string,
): T[] {
	if (!rank) return rows
	return rows
		.map((row, index) => ({ row, index, place: rank.get(idOf(row)) ?? Number.POSITIVE_INFINITY }))
		.sort((a, b) => (a.place === b.place ? a.index - b.index : a.place - b.place))
		.map(({ row }) => row)
}
