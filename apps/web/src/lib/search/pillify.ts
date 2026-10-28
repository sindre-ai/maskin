// Turns typed words into pills. Nothing converts on its own: plain words only
// ever produce a suggestion (the dashed-outline candidate on the last word), which
// the user accepts with Tab or a click. The one exception is the explicit forms
// type:loop, in:loop, status:done and is:done, which convert when followed by a space.
// Enter never converts anything.

import { type Pill, type SearchParts, addPill, hasPill, normalizeWords, setText } from './parts'
import type { Vocabulary } from './vocabulary'

export interface Suggestion {
	kind: Pill['kind']
	value: string
	/** The typed word or two-word phrase, as typed. Kept on the pill so Backspace can give it back. */
	word: string
	/** The text before the word, trailing space kept so typing can carry on after the pill. */
	head: string
}

interface Options {
	/** True while an IME composition is active: no detection until it commits. */
	composing?: boolean
}

const isQuoted = (word: string) => /^["']/.test(word)

interface Hit {
	kind: Pill['kind']
	value: string
	/** How many typed words the hit spans. */
	n: number
}

function lookup(vocab: Vocabulary, words: string[]): Hit | null {
	const last = words[words.length - 1].toLowerCase()
	const prev = words.length > 1 ? words[words.length - 2].toLowerCase() : ''
	if (prev && !isQuoted(prev)) {
		const status = vocab.statusWords.get(`${prev} ${last}`)
		if (status) return { kind: 'status', value: status, n: 2 }
	}
	const type = vocab.typeWords.get(last)
	if (type) return { kind: 'type', value: type, n: 1 }
	const status = vocab.statusWords.get(last)
	if (status) return { kind: 'status', value: status, n: 1 }
	return null
}

function split(text: string, n: number): { head: string; word: string } {
	const body = text.replace(/\s+$/, '')
	const m = body.match(new RegExp(`^([\\s\\S]*?)(\\S+(?:\\s+\\S+){${n - 1}})$`))
	return { head: m ? m[1] : '', word: m ? m[2] : body }
}

/** The candidate for the last word of the text, or null when nothing should be offered. */
export function suggest(
	parts: SearchParts,
	vocab: Vocabulary,
	{ composing = false }: Options = {},
): Suggestion | null {
	if (composing) return null
	const body = parts.text.replace(/\s+$/, '')
	if (!body) return null
	const words = body.split(/\s+/)
	if (isQuoted(words[words.length - 1])) return null
	const hit = lookup(vocab, words)
	if (!hit || hasPill(parts, hit.kind, hit.value)) return null
	const { head, word } = split(body, hit.n)
	if (parts.suppressed && normalizeWords(word) === parts.suppressed) return null
	return { kind: hit.kind, value: hit.value, word, head }
}

/** Tab or a click on the suggestion label. Returns null when no suggestion is showing. */
export function acceptSuggestion(parts: SearchParts, vocab: Vocabulary): SearchParts | null {
	const s = suggest(parts, vocab)
	if (!s) return null
	return {
		pills: [...parts.pills, { kind: s.kind, value: s.value, word: s.word }],
		text: s.head,
		suppressed: '',
	}
}

/** Esc. Hides the current suggestion until its word is edited. Null when none is showing. */
export function dismissSuggestion(parts: SearchParts, vocab: Vocabulary): SearchParts | null {
	const s = suggest(parts, vocab)
	return s ? { ...parts, suppressed: normalizeWords(s.word) } : null
}

/** type:loop or status:done as the last word, once a space follows it. */
function convertExplicit(parts: SearchParts, vocab: Vocabulary): SearchParts {
	if (!/\s$/.test(parts.text)) return parts
	const { head, word } = split(parts.text, 1)
	const m = word.match(/^(type|in|status|is):(.+)$/i)
	if (!m || isQuoted(word) || normalizeWords(word) === parts.suppressed) return parts
	const value = m[2].replace(/[_-]/g, ' ').toLowerCase()
	const isType = ['type', 'in'].includes(m[1].toLowerCase())
	const hit = isType ? vocab.typeWords.get(value) : vocab.statusWords.get(value)
	if (!hit) return parts
	const kind = isType ? 'type' : 'status'
	// A pill that is already there swallows the word instead of adding a second one.
	if (hasPill(parts, kind, hit)) return { ...parts, text: head }
	return { ...addPill(parts, { kind, value: hit, word }), text: head }
}

/** The user typed. Updates the text and converts a finished explicit form. */
export function typeText(
	parts: SearchParts,
	text: string,
	vocab: Vocabulary,
	{ composing = false }: Options = {},
): SearchParts {
	const next = setText(parts, text)
	return composing ? next : convertExplicit(next, vocab)
}
