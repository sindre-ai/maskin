import {
	EMPTY_PARTS,
	type SearchParts,
	addPill,
	backspaceToWord,
	dropPill,
	pillValues,
	queryText,
	removePill,
	setText,
} from '@/lib/search/parts'
import { acceptSuggestion, dismissSuggestion, suggest, typeText } from '@/lib/search/pillify'
import { describe, expect, it } from 'vitest'
import { vocab } from './fixtures'

const typed = (text: string, base: SearchParts = EMPTY_PARTS) => typeText(base, text, vocab)

describe('suggest and accept', () => {
	it('offers a type for the last word and keeps the word on the pill after Tab', () => {
		const parts = typed('hans loop')
		expect(suggest(parts, vocab)).toMatchObject({ kind: 'type', value: 'loop', word: 'loop' })

		const accepted = acceptSuggestion(parts, vocab)
		expect(accepted?.pills).toEqual([{ kind: 'type', value: 'loop', word: 'loop' }])
		expect(queryText(accepted as SearchParts)).toBe('hans')
	})

	it('Backspace at the start of the input puts the word back into the text', () => {
		const accepted = acceptSuggestion(typed('hans loop'), vocab) as SearchParts
		const reverted = backspaceToWord(accepted) as SearchParts
		expect(reverted.pills).toEqual([])
		expect(queryText(reverted)).toBe('hans loop')
	})

	it('does nothing on Backspace when there is no pill, so the key is left alone', () => {
		expect(backspaceToWord(typed('hans'))).toBeNull()
	})

	it('never converts on its own: typing a type word only produces a suggestion', () => {
		const parts = typed('hans loop ')
		expect(parts.pills).toEqual([])
		expect(suggest(parts, vocab)).not.toBeNull()
	})

	it('accept returns null when no suggestion is showing, so Tab is not swallowed', () => {
		expect(acceptSuggestion(typed('hello world'), vocab)).toBeNull()
		expect(acceptSuggestion(EMPTY_PARTS, vocab)).toBeNull()
	})

	it('turns a status word into a status pill without a type pill', () => {
		const accepted = acceptSuggestion(typed('hans done'), vocab) as SearchParts
		expect(accepted.pills).toEqual([{ kind: 'status', value: 'done', word: 'done' }])
		expect(queryText(accepted)).toBe('hans')
	})

	it('reads two-word statuses', () => {
		expect(suggest(typed('acme in progress'), vocab)).toMatchObject({
			kind: 'status',
			value: 'in_progress',
			word: 'in progress',
		})
		const needs = acceptSuggestion(typed('acme needs you'), vocab) as SearchParts
		expect(needs.pills).toEqual([{ kind: 'status', value: 'needs_you', word: 'needs you' }])
		expect(queryText(needs)).toBe('acme')
	})

	it('treats common title words as suggestions only, never as a trap', () => {
		for (const word of ['new', 'draft', 'done', 'chat']) {
			const parts = typed(`my ${word}`)
			expect(parts.pills).toEqual([])
			expect(parts.text).toBe(`my ${word}`)
			expect(suggest(parts, vocab)).not.toBeNull()
		}
	})

	it('keeps pills in the order they were added', () => {
		let parts = acceptSuggestion(typed('loop'), vocab) as SearchParts
		parts = typed('done', parts)
		parts = acceptSuggestion(parts, vocab) as SearchParts
		parts = typed('bet', parts)
		parts = acceptSuggestion(parts, vocab) as SearchParts
		expect(parts.pills.map((p) => p.value)).toEqual(['loop', 'done', 'bet'])
	})
})

describe('quoted words, reverted words and dismissal', () => {
	it('never suggests a quoted word', () => {
		expect(suggest(typed('"loop"'), vocab)).toBeNull()
		expect(suggest(typed("'done'"), vocab)).toBeNull()
		expect(suggest(typed('"in" progress'), vocab)).toBeNull()
	})

	it('does not suggest a reverted word again until it is edited', () => {
		const accepted = acceptSuggestion(typed('hans loop'), vocab) as SearchParts
		const reverted = backspaceToWord(accepted) as SearchParts
		expect(suggest(reverted, vocab)).toBeNull()

		// Typing more elsewhere keeps the word, so it stays quiet.
		expect(suggest(setText(reverted, `${reverted.text} x loop`), vocab)).toBeNull()

		// Editing the word out lifts the suppression.
		const edited = setText(reverted, 'hans')
		expect(edited.suppressed).toBe('')
		expect(suggest(setText(edited, 'hans loop'), vocab)).not.toBeNull()
	})

	it('Esc hides the suggestion until the word is edited', () => {
		const parts = typed('hans loop')
		const dismissed = dismissSuggestion(parts, vocab) as SearchParts
		expect(suggest(dismissed, vocab)).toBeNull()
		expect(dismissSuggestion(dismissed, vocab)).toBeNull()

		// Retyping the same word without editing it out stays quiet.
		expect(suggest(setText(dismissed, 'hans loop'), vocab)).toBeNull()

		// Editing the word out lifts the suppression, so typing it again suggests it.
		const edited = setText(dismissed, 'hans')
		expect(suggest(edited, vocab)).toBeNull()
		expect(suggest(setText(edited, 'hans loop'), vocab)).not.toBeNull()
	})

	it('skips detection while an IME composition is active', () => {
		const parts = typed('hans loop')
		expect(suggest(parts, vocab, { composing: true })).toBeNull()
		const explicit = typeText(EMPTY_PARTS, 'type:loop ', vocab, { composing: true })
		expect(explicit.pills).toEqual([])
		expect(typeText(EMPTY_PARTS, 'type:loop ', vocab).pills).toHaveLength(1)
	})
})

describe('pills made from chips', () => {
	it('removing a pill with no typed word drops only the filter', () => {
		const parts = addPill(typed('hans'), { kind: 'type', value: 'loop' })
		const removed = removePill(parts, 0)
		expect(removed.pills).toEqual([])
		expect(removed.text).toBe('hans')
		expect(removed.suppressed).toBe('')
	})

	it('dropPill by value never gives a word back, even for a typed pill', () => {
		const accepted = acceptSuggestion(typed('hans loop'), vocab) as SearchParts
		const dropped = dropPill(accepted, 'type', 'loop')
		expect(dropped.pills).toEqual([])
		expect(queryText(dropped)).toBe('hans')
	})

	it('does not add a duplicate pill', () => {
		const once = addPill(EMPTY_PARTS, { kind: 'type', value: 'loop' })
		expect(addPill(once, { kind: 'type', value: 'loop', word: 'loop' })).toBe(once)
		expect(addPill(once, { kind: 'status', value: 'loop' }).pills).toHaveLength(2)
	})

	it('does not suggest a pill that is already there', () => {
		const parts = addPill(typed('hans loop'), { kind: 'type', value: 'loop' })
		expect(suggest(parts, vocab)).toBeNull()
		expect(acceptSuggestion(parts, vocab)).toBeNull()
	})

	it('keeps status pills when a type pill is added or dropped', () => {
		let parts = addPill(EMPTY_PARTS, { kind: 'status', value: 'done' })
		parts = addPill(parts, { kind: 'type', value: 'bet' })
		parts = dropPill(parts, 'type', 'bet')
		parts = addPill(parts, { kind: 'type', value: 'task' })
		expect(pillValues(parts, 'status')).toEqual(['done'])
		expect(pillValues(parts, 'type')).toEqual(['task'])
	})
})

describe('explicit forms', () => {
	it('converts type:loop only once a space follows', () => {
		expect(typed('hans type:loop').pills).toEqual([])
		const done = typed('hans type:loop ')
		expect(done.pills).toEqual([{ kind: 'type', value: 'loop', word: 'type:loop' }])
		expect(queryText(done)).toBe('hans')
	})

	it('handles in:, status: and is: with aliases and separators', () => {
		expect(typed('in:loops ').pills[0]).toMatchObject({ kind: 'type', value: 'loop' })
		expect(typed('status:done ').pills[0]).toMatchObject({ kind: 'status', value: 'done' })
		const progress = typed('is:in_progress ')
		expect(progress.pills[0]).toMatchObject({ kind: 'status', value: 'in_progress' })
		expect(typed('type:customer ').pills[0]).toMatchObject({ kind: 'type', value: 'company' })
	})

	it('leaves unknown values, quoted forms and wrong keys alone', () => {
		expect(typed('type:nope ').pills).toEqual([])
		expect(typed('status:loop ').pills).toEqual([])
		expect(typed('"type:loop" ').pills).toEqual([])
	})

	it('swallows the word when the pill already exists', () => {
		const base = addPill(EMPTY_PARTS, { kind: 'type', value: 'loop' })
		const parts = typed('hans type:loop ', base)
		expect(parts.pills).toHaveLength(1)
		expect(queryText(parts)).toBe('hans')
	})

	it('Backspace turns an explicit pill back into its typed form', () => {
		const reverted = backspaceToWord(typed('hans type:loop ')) as SearchParts
		expect(queryText(reverted)).toBe('hans type:loop')
	})

	it('does not convert a reverted explicit form again', () => {
		const reverted = backspaceToWord(typed('hans type:loop ')) as SearchParts
		expect(typed(`${reverted.text} `, reverted).pills).toEqual([])
	})
})
