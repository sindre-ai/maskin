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

export interface SettledSearchV2Input {
	/** The surface the search ran on. The page by default; the launcher passes command_palette. */
	surface?: SearchSurface
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
	const {
		surface = 'search_view',
		active,
		query,
		types,
		statuses,
		updated,
		sort,
		entry,
		isSettled,
		isPartial,
		total,
	} = input
	const trimmed = query.trim()
	const typeFilter = [...types].sort().join(',')
	const statusFilter = [...statuses].sort().join(',')
	const firedKey = useRef<string | null>(null)
	const firedSearch = useRef<SettledSearch | null>(null)

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
		if (!isSettled) return
		const key = [trimmed, typeFilter, statusFilter, updated].join('\u0000')
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
			type_filter: typeFilter || null,
			status_filter: statusFilter || null,
			ui_version: 'v2',
			entry,
			pill_count: types.length + statuses.length,
			filter_count: (types.length ? 1 : 0) + (statuses.length ? 1 : 0) + (updated ? 1 : 0),
			sort,
		})
	}, [
		surface,
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

export type SearchGroup = 'chats' | 'loops' | 'agents' | 'people' | 'objects' | 'automations'

const ENTITY_TYPE_BY_GROUP: Record<Exclude<SearchGroup, 'objects'>, TaxonomyEntityType> = {
	chats: 'conversation',
	loops: 'loop',
	agents: 'agent',
	people: 'actor',
	automations: 'trigger',
}

/** The taxonomy entity type of a v2 result row: the object's own type for objects, else by group. */
export function searchEntityType(group: SearchGroup, objectType: string): TaxonomyEntityType {
	if (group === 'objects') return objectType as TaxonomyEntityType
	return ENTITY_TYPE_BY_GROUP[group]
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
