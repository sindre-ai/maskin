// The field's value: one leading group of pills followed by one text input.
// A pill does not keep its typed position. Backspace at the start of the input
// turns the last pill back into its typed word, appended to the text.
// Plain data in, plain data out: every operation returns a new value.

import type { PillKind } from './vocabulary'

export interface Pill {
	kind: PillKind
	/** Type key or status group key. */
	value: string
	/** The word the user typed to make this pill. Absent for pills made from chips or Display. */
	word?: string
}

export interface SearchParts {
	pills: Pill[]
	text: string
	/**
	 * Lowercase word or phrase that must not be suggested again. Set when a pill is
	 * reverted to its word or a suggestion is dismissed; cleared once the user edits
	 * that word out of the text.
	 */
	suppressed: string
}

export const EMPTY_PARTS: SearchParts = { pills: [], text: '', suppressed: '' }

export function normalizeWords(text: string): string {
	return text.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

function hasWords(text: string, phrase: string): boolean {
	return ` ${normalizeWords(text)} `.includes(` ${phrase} `)
}

/** The words to search for: the text with runs of whitespace collapsed and the ends trimmed. */
export function queryText(parts: SearchParts): string {
	return parts.text.trim().split(/\s+/).filter(Boolean).join(' ')
}

export function hasPill(parts: SearchParts, kind: PillKind, value: string): boolean {
	return parts.pills.some((p) => p.kind === kind && p.value === value)
}

export function pillValues(parts: SearchParts, kind: PillKind): string[] {
	return parts.pills.filter((p) => p.kind === kind).map((p) => p.value)
}

export function joinWords(text: string, word: string): string {
	return text && !/\s$/.test(text) ? `${text} ${word}` : `${text}${word}`
}

/** Replaces the text. Lifts the suppression once the suppressed word is gone from it. */
export function setText(parts: SearchParts, text: string): SearchParts {
	const suppressed = parts.suppressed && hasWords(text, parts.suppressed) ? parts.suppressed : ''
	return { ...parts, text, suppressed }
}

/** Adds a pill after the existing ones. A duplicate (same kind and value) is not added twice. */
export function addPill(parts: SearchParts, pill: Pill): SearchParts {
	if (hasPill(parts, pill.kind, pill.value)) return parts
	return { ...parts, pills: [...parts.pills, pill] }
}

/**
 * Removes the pill at index. A pill that remembers its typed word gives the word
 * back to the text and is not suggested again until the word is edited; a pill
 * made from a chip only drops the filter.
 */
export function removePill(parts: SearchParts, index: number): SearchParts {
	const pill = parts.pills[index]
	if (!pill) return parts
	const pills = parts.pills.filter((_, i) => i !== index)
	if (!pill.word) return { ...parts, pills }
	return { pills, text: joinWords(parts.text, pill.word), suppressed: normalizeWords(pill.word) }
}

/** Removes a pill by kind and value (chip or Display toggle): the filter goes, no word comes back. */
export function dropPill(parts: SearchParts, kind: PillKind, value: string): SearchParts {
	if (!hasPill(parts, kind, value)) return parts
	return { ...parts, pills: parts.pills.filter((p) => !(p.kind === kind && p.value === value)) }
}

/**
 * Backspace with the caret at the start of the input. Reverts the last pill, or
 * returns null when there is no pill so the caller leaves the key alone.
 */
export function backspaceToWord(parts: SearchParts): SearchParts | null {
	if (!parts.pills.length) return null
	return removePill(parts, parts.pills.length - 1)
}

/** Builds parts from filters held elsewhere (the URL). Pills go before the text. */
export function partsFrom(types: string[], statuses: string[], text: string): SearchParts {
	return {
		pills: [
			...types.map((value): Pill => ({ kind: 'type', value })),
			...statuses.map((value): Pill => ({ kind: 'status', value })),
		],
		text,
		suppressed: '',
	}
}
