// One source of truth for the search field. The text, the pills, the type and
// status chips and the Display menu all read and write this reducer: chips and
// Display add or remove pills, so the field and the chips can never disagree.

import { type WordHit, applyWord } from '@/lib/search/empty-state'
import {
	EMPTY_PARTS,
	type SearchParts,
	addPill,
	backspaceToWord,
	dropPill,
	hasPill,
	pillValues,
	queryText,
	removePill,
} from '@/lib/search/parts'
import {
	type Suggestion,
	acceptSuggestion,
	dismissSuggestion,
	suggest,
	typeText,
} from '@/lib/search/pillify'
import {
	type SearchSort,
	type SearchUrlState,
	type UpdatedFilter,
	partsFromUrlState,
	serializeSearchState,
	urlStateFromParts,
} from '@/lib/search/url-state'
import type { Vocabulary } from '@/lib/search/vocabulary'
import { useMemo, useReducer } from 'react'

export interface SearchState {
	parts: SearchParts
	updated: UpdatedFilter
	sort: SearchSort
}

export type SearchAction =
	| { type: 'text'; text: string; composing?: boolean }
	| { type: 'accept' }
	| { type: 'dismiss' }
	| { type: 'backspace' }
	| { type: 'removePill'; index: number }
	| { type: 'applyWord'; hit: WordHit }
	| { type: 'toggleType'; value: string }
	| { type: 'toggleStatus'; value: string }
	| { type: 'setUpdated'; value: UpdatedFilter }
	| { type: 'setSort'; value: SearchSort }
	| { type: 'clearFilters' }
	| { type: 'hydrate'; state: SearchUrlState }

export const INITIAL_SEARCH_STATE: SearchState = { parts: EMPTY_PARTS, updated: '', sort: 'rel' }

export function stateFromUrl(url: SearchUrlState): SearchState {
	return { parts: partsFromUrlState(url), updated: url.updated, sort: url.sort }
}

function toggle(parts: SearchParts, kind: 'type' | 'status', value: string): SearchParts {
	return hasPill(parts, kind, value)
		? dropPill(parts, kind, value)
		: addPill(parts, { kind, value })
}

/** The reducer needs the vocabulary to convert typed forms, so it is built per vocabulary. */
export function createSearchReducer(vocab: Vocabulary) {
	return function searchReducer(state: SearchState, action: SearchAction): SearchState {
		const { parts } = state
		switch (action.type) {
			case 'text':
				return { ...state, parts: typeText(parts, action.text, vocab, action) }
			case 'accept':
				return { ...state, parts: acceptSuggestion(parts, vocab) ?? parts }
			case 'dismiss':
				return { ...state, parts: dismissSuggestion(parts, vocab) ?? parts }
			case 'backspace':
				return { ...state, parts: backspaceToWord(parts) ?? parts }
			case 'removePill':
				return { ...state, parts: removePill(parts, action.index) }
			case 'applyWord':
				return { ...state, parts: applyWord(parts, action.hit) }
			case 'toggleType':
				return { ...state, parts: toggle(parts, 'type', action.value) }
			case 'toggleStatus':
				return { ...state, parts: toggle(parts, 'status', action.value) }
			case 'setUpdated':
				return { ...state, updated: action.value }
			case 'setSort':
				return { ...state, sort: action.value }
			case 'clearFilters':
				// Keeps the words and the sort, drops pills and the Updated filter.
				return { ...state, parts: { ...parts, pills: [] }, updated: '' }
			case 'hydrate': {
				// The URL echoing our own change back must not wipe the words pills remember.
				const current = serializeSearchState(urlStateFromParts(parts, state.updated, state.sort))
				const incoming = serializeSearchState(action.state)
				const same = JSON.stringify(current) === JSON.stringify(incoming)
				return same ? state : stateFromUrl(action.state)
			}
		}
	}
}

export interface UseSearchState {
	state: SearchState
	dispatch: (action: SearchAction) => void
	/** The dashed-outline candidate for the last word, if one is showing. */
	suggestion: Suggestion | null
	types: string[]
	statuses: string[]
	/** The words to search for. */
	query: string
}

export function useSearchState(
	vocab: Vocabulary,
	initial: SearchUrlState | null = null,
): UseSearchState {
	const reducer = useMemo(() => createSearchReducer(vocab), [vocab])
	const [state, dispatch] = useReducer(reducer, initial, (url) =>
		url ? stateFromUrl(url) : INITIAL_SEARCH_STATE,
	)
	return useMemo(
		() => ({
			state,
			dispatch,
			suggestion: suggest(state.parts, vocab),
			types: pillValues(state.parts, 'type'),
			statuses: pillValues(state.parts, 'status'),
			query: queryText(state.parts),
		}),
		[state, vocab],
	)
}
