// Search state in the URL: q, types, statuses, participants, updated, sort. Pill order is not stored: on
// hydrate, pills go before the text.

import { SEARCH_MAX_PARTICIPANTS } from '@maskin/shared'
import { type SearchParts, partsFrom, pillValues } from './parts'
import { isStatusGroup } from './vocabulary'

export const UPDATED_VALUES = ['day', 'week', 'month'] as const
export type UpdatedFilter = '' | (typeof UPDATED_VALUES)[number]

export const SORT_VALUES = ['rel', 'recent', 'az'] as const
export type SearchSort = (typeof SORT_VALUES)[number]

export interface SearchUrlState {
	text: string
	types: string[]
	statuses: string[]
	/** Actor ids (people or agents) who must all be in a chat. */
	participants: string[]
	updated: UpdatedFilter
	sort: SearchSort
}

// A type alias, not an interface, so it is assignable to Record<string, unknown>.
export type SearchUrlParams = {
	q?: string
	types?: string
	statuses?: string
	participants?: string
	updated?: string
	sort?: string
}

const MAX_TEXT = 200
// The server answers 400 to anything that is not an id, or to more than the cap.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const EMPTY_URL_STATE: SearchUrlState = {
	text: '',
	types: [],
	statuses: [],
	participants: [],
	updated: '',
	sort: 'rel',
}

/** Defaults are left out, so a bare /search stays bare. */
export function serializeSearchState(state: SearchUrlState): SearchUrlParams {
	const params: SearchUrlParams = {}
	const q = state.text.trim()
	if (q) params.q = q
	if (state.types.length) params.types = state.types.join(',')
	if (state.statuses.length) params.statuses = state.statuses.join(',')
	if (state.participants.length) params.participants = state.participants.join(',')
	if (state.updated) params.updated = state.updated
	if (state.sort !== 'rel') params.sort = state.sort
	return params
}

function csv(value: unknown): string[] {
	if (typeof value !== 'string') return []
	const items = value.split(',').map((v) => v.trim())
	return [...new Set(items.filter(Boolean))]
}

/** Reads any param bag (a router's search object or Object.fromEntries of URLSearchParams). Never throws. */
export function parseSearchState(params: Record<string, unknown>): SearchUrlState {
	const updated = params.updated
	const sort = params.sort
	return {
		text: typeof params.q === 'string' ? params.q.trim().slice(0, MAX_TEXT) : '',
		types: csv(params.types),
		statuses: csv(params.statuses).filter(isStatusGroup),
		participants: csv(params.participants)
			.filter((id) => UUID.test(id))
			.slice(0, SEARCH_MAX_PARTICIPANTS),
		updated: UPDATED_VALUES.find((v) => v === updated) ?? '',
		sort: SORT_VALUES.find((v) => v === sort) ?? 'rel',
	}
}

/** The URL half of the state, taken from the field's parts. */
export function urlStateFromParts(
	parts: SearchParts,
	updated: UpdatedFilter,
	sort: SearchSort,
): SearchUrlState {
	return {
		text: parts.text,
		types: pillValues(parts, 'type'),
		statuses: pillValues(parts, 'status'),
		participants: pillValues(parts, 'participant'),
		updated,
		sort,
	}
}

export function partsFromUrlState(state: SearchUrlState): SearchParts {
	return partsFrom(state.types, state.statuses, state.text, state.participants)
}
