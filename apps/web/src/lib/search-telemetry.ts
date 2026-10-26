import type { SearchGroup, SearchRow } from '@/hooks/use-workspace-search'
import {
	type SearchEntry,
	type SearchSortKey,
	type SearchSurface,
	type SearchUiVersion,
	type TaxonomyEntityType,
	trackSearchPerformed,
	trackSearchResultOpened,
} from '@/lib/analytics'
import { useEffect, useRef } from 'react'

/** How long a typed query rests before it is committed and searched. The search
 *  page and the palette both debounce on this, and a search only counts as
 *  settled after it — so the two surfaces cannot drift apart. */
export const SEARCH_DEBOUNCE_MS = 300

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

const V2_SURFACE: SearchSurface = 'search_view'

export interface SettledSearchV2Input {
	/** False when there is nothing to report (no words typed). Clears the dedupe memory. */
	active: boolean
	query: string
	types: string[]
	statuses: string[]
	updated: string
	sort: SearchSortKey
	entry: SearchEntry
	/** The request succeeded and this is its own answer, not the previous results kept on screen. */
	isSettled: boolean
	isPartial: boolean
	total: number
}

/**
 * The v2 page's `search_performed`. Fires once per settled request with words in it:
 * never while loading, on error, or for placeholder data. A different query, type
 * set, status set or Updated window is a new search; a sort change is not (it
 * reorders the same results). Filter-only searches (no words) do not fire, so the
 * event keeps the meaning it had on the old page.
 */
export function useTrackSettledSearchV2(input: SettledSearchV2Input): void {
	const { active, query, types, statuses, updated, sort, entry, isSettled, isPartial, total } =
		input
	const trimmed = query.trim()
	const typeFilter = [...types].sort().join(',')
	const statusFilter = [...statuses].sort().join(',')
	const firedKey = useRef<string | null>(null)
	const firedSearch = useRef<SettledSearch | null>(null)

	useEffect(
		() => () => {
			delete lastSearch[V2_SURFACE]
		},
		[],
	)

	useEffect(() => {
		if (!active || !trimmed) {
			firedKey.current = null
			firedSearch.current = null
			delete lastSearch[V2_SURFACE]
			return
		}
		if (!isSettled) return
		const key = [trimmed, typeFilter, statusFilter, updated].join('\u0000')
		if (firedKey.current === key) {
			if (firedSearch.current) lastSearch[V2_SURFACE] = firedSearch.current
			return
		}
		firedKey.current = key
		const searchId = newSearchId()
		firedSearch.current = { id: searchId, resultCount: total }
		lastSearch[V2_SURFACE] = firedSearch.current
		trackSearchPerformed({
			surface: 'search_view',
			search_id: searchId,
			result_count: total,
			is_partial: isPartial,
			query_length: trimmed.length,
			words_count: countWords(trimmed),
			type_filter: typeFilter || null,
			status_filter: statusFilter || null,
			ui_version: 'v2',
			entry,
			pill_count: types.length + statuses.length,
			filter_count: (types.length ? 1 : 0) + (statuses.length ? 1 : 0) + (updated ? 1 : 0),
			sort,
		})
	}, [
		active,
		trimmed,
		typeFilter,
		statusFilter,
		updated,
		sort,
		entry,
		isSettled,
		isPartial,
		total,
		types.length,
		statuses.length,
	])
}

const ENTITY_TYPE_BY_GROUP: Record<Exclude<SearchGroup, 'objects'>, TaxonomyEntityType> = {
	chats: 'conversation',
	loops: 'loop',
	agents: 'agent',
	automations: 'trigger',
}

/** The taxonomy entity type of a v2 result row: the object's own type for objects, else by group. */
export function searchEntityType(group: SearchGroup, objectType: string): TaxonomyEntityType {
	if (group === 'objects') return objectType as TaxonomyEntityType
	return ENTITY_TYPE_BY_GROUP[group]
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
	uiVersion?: SearchUiVersion
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
		...(p.uiVersion ? { ui_version: p.uiVersion } : {}),
	})
}
