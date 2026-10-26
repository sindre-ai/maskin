import type { SearchGroup, SearchRow } from '@/hooks/use-workspace-search'
import {
	type SearchSurface,
	type TaxonomyEntityType,
	trackSearchPerformed,
	trackSearchResultOpened,
} from '@/lib/analytics'
import { useEffect, useRef } from 'react'

/** How long a typed query rests before it is committed and searched on the
 *  search page, and a search only counts as settled after it. */
export const SEARCH_DEBOUNCE_MS = 300

/** The palette filters its local lists on every keystroke, so only the
 *  `/objects/search` call waits; this is how long. */
export const PALETTE_SERVER_DEBOUNCE_MS = 100

/** Number of whitespace-separated words in the query. An integer only: the
 *  query text itself is never sent to analytics. */
export function countWords(query: string): number {
	const trimmed = query.trim()
	return trimmed ? trimmed.split(/\s+/).length : 0
}

interface SettledSearch {
	id: string
	resultCount: number
}

// The last settled search per surface. `search_performed` writes it and
// `search_result_opened` reads it, which is how an open is joined to its search.
const lastSearch: Partial<Record<SearchSurface, SettledSearch>> = {}

function newSearchId(): string {
	return typeof crypto !== 'undefined' && 'randomUUID' in crypto
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface SettledSearchInput {
	surface: SearchSurface
	/** False while the surface has nothing to report (palette closed, no query).
	 *  Clears the dedupe memory and the last search. */
	active: boolean
	query: string
	type?: string
	status?: string
	isSettled: boolean
	isError: boolean
	isPartial: boolean
	total: number
}

/**
 * Fires `search_performed` once per settled search: a non-empty trimmed query
 * whose results have all arrived and whose object search did not fail. A change
 * of surface, trimmed query, type or status filter is a new search; a group chip
 * change is not (it changes none of these inputs).
 */
export function useTrackSettledSearch(input: SettledSearchInput): void {
	const { surface, active, query, type, status, isSettled, isError, isPartial, total } = input
	const trimmed = query.trim()
	const firedKey = useRef<string | null>(null)
	// Kept next to the dedupe key so a StrictMode effect replay (cleanup, then the
	// same effects again) can restore the search the cleanup below just dropped.
	const firedSearch = useRef<SettledSearch | null>(null)

	// A surface that unmounts takes its last search with it.
	useEffect(
		() => () => {
			delete lastSearch[surface]
		},
		[surface],
	)

	useEffect(() => {
		if (!active || !trimmed) {
			firedKey.current = null
			firedSearch.current = null
			delete lastSearch[surface]
			return
		}
		if (!isSettled || isError) return
		const key = `${trimmed}\u0000${type ?? ''}\u0000${status ?? ''}`
		if (firedKey.current === key) {
			if (firedSearch.current) lastSearch[surface] = firedSearch.current
			return
		}
		firedKey.current = key
		const searchId = newSearchId()
		firedSearch.current = { id: searchId, resultCount: total }
		lastSearch[surface] = firedSearch.current
		trackSearchPerformed({
			surface,
			search_id: searchId,
			result_count: total,
			is_partial: isPartial,
			query_length: trimmed.length,
			words_count: countWords(trimmed),
			type_filter: type ?? null,
			status_filter: status ?? null,
		})
	}, [surface, active, trimmed, type, status, isSettled, isError, isPartial, total])
}

const ENTITY_TYPE_BY_GROUP: Record<Exclude<SearchGroup, 'objects'>, TaxonomyEntityType> = {
	chats: 'conversation',
	loops: 'loop',
	agents: 'agent',
	people: 'actor',
	automations: 'trigger',
}

export function searchRowEntityType(row: SearchRow): TaxonomyEntityType {
	if (row.group === 'objects') return (row.object?.type ?? 'object') as TaxonomyEntityType
	return ENTITY_TYPE_BY_GROUP[row.group]
}

/**
 * Fires `search_result_opened` for a result row (any group) or a recent object.
 * `hasQuery` false marks recents and the palette's empty-query list: those carry
 * no search_id and count against the size of the list shown. `position` is
 * 1-based in rendered order.
 */
export function trackSearchRowOpened(p: {
	surface: SearchSurface
	entityId: string
	entityType: TaxonomyEntityType
	group: SearchGroup
	position: number
	hasQuery: boolean
	/** Size of the list the row was shown in; used when no search is on record. */
	listSize: number
}): void {
	const search = p.hasQuery ? lastSearch[p.surface] : undefined
	trackSearchResultOpened({
		entity_id: p.entityId,
		entity_type: p.entityType,
		surface: p.surface,
		search_id: search?.id ?? null,
		has_query: p.hasQuery,
		result_count: search?.resultCount ?? p.listSize,
		position: p.position,
		result_group: p.group,
	})
}
