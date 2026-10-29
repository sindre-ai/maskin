// Data for the v2 search page: one call to GET /api/search, which searches all five
// sources and returns the true counts. Words wait 250ms before they are sent;
// filters apply at once. The previous answer stays on screen while a new one loads,
// so typing never flashes a skeleton, and the abort signal cancels a request that a
// newer one has replaced.

import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import type { SearchSort, UpdatedFilter } from '@/lib/search/url-state'
import type { SearchResponse } from '@maskin/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

export const SEARCH_QUERY_DEBOUNCE_MS = 250
const STALE_TIME_MS = 15_000

const HOUR_MS = 60 * 60 * 1000
const UPDATED_WINDOW_MS: Record<Exclude<UpdatedFilter, ''>, number> = {
	day: 24 * HOUR_MS,
	week: 7 * 24 * HOUR_MS,
	month: 30 * 24 * HOUR_MS,
}

/** The value, delayed. Anything that changes it again inside the delay replaces it. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		if (Object.is(debounced, value)) return
		const timer = setTimeout(() => setDebounced(value), delayMs)
		return () => clearTimeout(timer)
	}, [value, delayMs, debounced])
	return debounced
}

export interface SearchQueryInput {
	/** The words, already debounced. */
	text: string
	types: string[]
	statuses: string[]
	updated: UpdatedFilter
	sort: SearchSort
	/** Cap on the rows sent back. The launcher asks for a few; the page takes the default. */
	limit?: number
}

/** True when there is anything to ask: words or at least one filter. Sort alone is not enough. */
export function hasSearchInput(input: SearchQueryInput): boolean {
	return (
		input.text.trim() !== '' ||
		input.types.length > 0 ||
		input.statuses.length > 0 ||
		input.updated !== ''
	)
}

/** The request's query string. The Updated window is turned into a cutoff when the request runs. */
export function buildSearchParams(input: SearchQueryInput, now: number = Date.now()) {
	const params: Record<string, string> = {}
	const q = input.text.trim()
	if (q) params.q = q
	if (input.types.length) params.types = input.types.join(',')
	if (input.statuses.length) params.statuses = input.statuses.join(',')
	if (input.updated) {
		params.updated_after = new Date(now - UPDATED_WINDOW_MS[input.updated]).toISOString()
	}
	if (input.sort !== 'rel') params.sort = input.sort
	if (input.limit) params.limit = String(input.limit)
	return params
}

export function useSearchQuery(workspaceId: string, input: SearchQueryInput, active = true) {
	const enabled = active && hasSearchInput(input)
	return useQuery<SearchResponse>({
		// The Updated window is kept as its name in the key; the cutoff time is computed
		// inside queryFn so the key does not change every time the clock does.
		queryKey: queryKeys.search.results(workspaceId, {
			q: input.text.trim(),
			types: input.types,
			statuses: input.statuses,
			updated: input.updated,
			sort: input.sort,
			limit: input.limit,
		}),
		queryFn: ({ signal }) => api.search.query(workspaceId, buildSearchParams(input), { signal }),
		enabled,
		placeholderData: keepPreviousData,
		staleTime: STALE_TIME_MS,
	})
}
