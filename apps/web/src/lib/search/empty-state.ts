// What the search page says when a search finds nothing. When the words contain a
// type or status word ("hans active"), the page names it and offers the matching
// chip as the next step, so a zero result never stays unexplained. Pure data in,
// plain data out; the page only renders it.

import { type Pill, type SearchParts, addPill, hasPill } from './parts'
import { type Vocabulary, pillLabel } from './vocabulary'

export interface WordHit {
	kind: Pill['kind']
	/** Type key or status group key. */
	value: string
	/** The word or two-word phrase as typed. */
	word: string
	/** Index of the first typed word in the text, and how many words it spans. */
	start: number
	count: number
	/** Display name of the filter this word would become. */
	label: string
}

const isQuoted = (word: string) => /^["']/.test(word)

/**
 * The type and status words in the text that are not pills yet, in typed order.
 * Quoted words are never read as filters, same as the field's own suggestions.
 */
export function findFilterWords(parts: SearchParts, vocab: Vocabulary): WordHit[] {
	const words = parts.text.trim().split(/\s+/).filter(Boolean)
	const hits: WordHit[] = []
	for (let i = 0; i < words.length; i++) {
		const word = words[i]
		if (isQuoted(word)) continue
		const lower = word.toLowerCase()
		if (i + 1 < words.length && !isQuoted(words[i + 1])) {
			const phrase = `${lower} ${words[i + 1].toLowerCase()}`
			const status = vocab.statusWords.get(phrase)
			if (status && !hasPill(parts, 'status', status)) {
				hits.push({
					kind: 'status',
					value: status,
					word: `${word} ${words[i + 1]}`,
					start: i,
					count: 2,
					label: pillLabel(vocab, 'status', status),
				})
				i += 1
				continue
			}
		}
		const type = vocab.typeWords.get(lower)
		if (type) {
			if (!hasPill(parts, 'type', type)) {
				hits.push({
					kind: 'type',
					value: type,
					word,
					start: i,
					count: 1,
					label: pillLabel(vocab, 'type', type),
				})
			}
			continue
		}
		const status = vocab.statusWords.get(lower)
		if (status && !hasPill(parts, 'status', status)) {
			hits.push({
				kind: 'status',
				value: status,
				word,
				start: i,
				count: 1,
				label: pillLabel(vocab, 'status', status),
			})
		}
	}
	return hits
}

/**
 * Turns a typed word into its pill from the empty state. The word leaves the text
 * and the pill remembers it, so Backspace brings it back.
 */
export function applyWord(parts: SearchParts, hit: WordHit): SearchParts {
	const words = parts.text.trim().split(/\s+/).filter(Boolean)
	const rest = [...words.slice(0, hit.start), ...words.slice(hit.start + hit.count)]
	const text = rest.length ? `${rest.join(' ')} ` : ''
	const next = addPill({ ...parts, text }, { kind: hit.kind, value: hit.value, word: hit.word })
	return next
}

export interface EmptyExplanation {
	title: string
	/** Sentences naming the filter words, one per hit. */
	wordNotes: string[]
	/** The chips to offer as the next step, one per hit. */
	hits: WordHit[]
	/** Pills or an Updated window are narrowing the list. */
	filtered: boolean
	/** Results if the status filter were dropped; null unless a status pill is on. */
	withoutStatuses: number | null
	/** Results for the words alone; 0 when there is nothing to widen to. */
	everything: number
}

export function explainEmpty(input: {
	parts: SearchParts
	vocab: Vocabulary
	updated: string
	relaxed: { withoutFilters: number; withoutStatuses: number }
}): EmptyExplanation {
	const { parts, vocab, updated, relaxed } = input
	const text = parts.text.trim().split(/\s+/).filter(Boolean).join(' ')
	const filtered = parts.pills.length > 0 || updated !== ''
	const hits = findFilterWords(parts, vocab)
	const hasStatusPill = parts.pills.some((p) => p.kind === 'status')
	return {
		title: filtered ? 'No results with these filters' : `Nothing matches “${text}”`,
		wordNotes: hits.map((hit) =>
			hit.kind === 'status'
				? `“${hit.word}” is a status. Pick a type first, then choose a status.`
				: `“${hit.word}” is a type. Choose it below to filter by type.`,
		),
		hits,
		filtered,
		withoutStatuses: hasStatusPill ? relaxed.withoutStatuses : null,
		everything: filtered ? relaxed.withoutFilters : 0,
	}
}
