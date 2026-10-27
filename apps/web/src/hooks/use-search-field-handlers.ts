// What the search field does when a person edits it: typing, accepting a suggestion,
// Backspace at the start, and removing a pill. Each edit is reported as
// search_filter_changed when it adds or removes a pill. The page and the launcher
// share it, so a pill behaves and is counted the same in both.

import {
	type SearchFilterAction,
	type SearchFilterDimension,
	type SearchFilterKind,
	type SearchFilterVia,
	type SearchSurface,
	trackSearchFilterChanged,
} from '@/lib/analytics'
import type { SearchParts } from '@/lib/search/parts'
import { type Suggestion, typeText } from '@/lib/search/pillify'
import type { Vocabulary } from '@/lib/search/vocabulary'
import { type RefObject, useCallback } from 'react'
import type { SearchAction } from './use-search-state'

interface Input {
	surface: SearchSurface
	parts: SearchParts
	vocab: Vocabulary
	suggestion: Suggestion | null
	dispatch: (action: SearchAction) => void
	inputRef: RefObject<HTMLInputElement | null>
	/** Called when the person edits the field by hand (the search then counts as typed). */
	onEdit?: () => void
}

export interface FilterChange {
	dimension: SearchFilterDimension
	action: SearchFilterAction
	value: string
	kind: SearchFilterKind
	via: SearchFilterVia
}

export function useSearchFieldHandlers({
	surface,
	parts,
	vocab,
	suggestion,
	dispatch,
	inputRef,
	onEdit,
}: Input) {
	const track = useCallback(
		(change: FilterChange) => trackSearchFilterChanged({ surface, ...change }),
		[surface],
	)

	const onTextChange = (text: string, composing: boolean) => {
		const next = typeText(parts, text, vocab, { composing })
		if (next.pills.length > parts.pills.length) {
			const pill = next.pills[next.pills.length - 1]
			track({ dimension: pill.kind, action: 'add', value: pill.value, kind: 'pill', via: 'typed' })
		}
		onEdit?.()
		dispatch({ type: 'text', text, composing })
	}
	const onAcceptSuggestion = (via: 'tab' | 'click') => {
		if (!suggestion) return
		track({
			dimension: suggestion.kind,
			action: 'add',
			value: suggestion.value,
			kind: 'pill',
			via,
		})
		onEdit?.()
		dispatch({ type: 'accept' })
		inputRef.current?.focus()
	}
	const onBackspaceToWord = () => {
		const pill = parts.pills[parts.pills.length - 1]
		if (pill) {
			track({
				dimension: pill.kind,
				action: 'remove',
				value: pill.value,
				kind: 'pill',
				via: 'backspace',
			})
		}
		dispatch({ type: 'backspace' })
	}
	const onRemovePill = (index: number) => {
		const pill = parts.pills[index]
		if (pill) {
			track({
				dimension: pill.kind,
				action: 'remove',
				value: pill.value,
				kind: 'pill',
				via: 'click',
			})
		}
		dispatch({ type: 'removePill', index })
		inputRef.current?.focus()
	}

	return { track, onTextChange, onAcceptSuggestion, onBackspaceToWord, onRemovePill }
}
