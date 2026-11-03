import { INITIAL_SEARCH_STATE, createSearchReducer } from '@/hooks/use-search-state'
import { pillValues, queryText } from '@/lib/search/parts'
import { suggest } from '@/lib/search/pillify'
import { EMPTY_URL_STATE } from '@/lib/search/url-state'
import { describe, expect, it } from 'vitest'
import { vocab } from '../lib/search/fixtures'

const reduce = createSearchReducer(vocab)

describe('search state reducer', () => {
	it('walks the hans loop flow end to end', () => {
		let s = reduce(INITIAL_SEARCH_STATE, { type: 'text', text: 'hans loop' })
		expect(suggest(s.parts, vocab)?.value).toBe('loop')
		s = reduce(s, { type: 'accept' })
		expect(pillValues(s.parts, 'type')).toEqual(['loop'])
		expect(queryText(s.parts)).toBe('hans')
		s = reduce(s, { type: 'backspace' })
		expect(s.parts.pills).toEqual([])
		expect(queryText(s.parts)).toBe('hans loop')
	})

	it('chips add and remove pills, and removal brings back no word', () => {
		let s = reduce(INITIAL_SEARCH_STATE, { type: 'text', text: 'hans' })
		s = reduce(s, { type: 'toggleType', value: 'bet' })
		s = reduce(s, { type: 'toggleStatus', value: 'done' })
		expect(s.parts.pills.map((p) => p.value)).toEqual(['bet', 'done'])
		s = reduce(s, { type: 'toggleType', value: 'bet' })
		expect(pillValues(s.parts, 'status')).toEqual(['done'])
		expect(queryText(s.parts)).toBe('hans')
	})

	it('changing the type keeps the status pills', () => {
		let s = reduce(INITIAL_SEARCH_STATE, { type: 'toggleStatus', value: 'done' })
		s = reduce(s, { type: 'toggleType', value: 'bet' })
		s = reduce(s, { type: 'toggleType', value: 'bet' })
		s = reduce(s, { type: 'toggleType', value: 'task' })
		expect(pillValues(s.parts, 'status')).toEqual(['done'])
	})

	it('toggling twice never leaves a duplicate', () => {
		let s = reduce(INITIAL_SEARCH_STATE, { type: 'toggleType', value: 'bet' })
		s = reduce(s, { type: 'toggleType', value: 'bet' })
		expect(s.parts.pills).toEqual([])
	})

	it('the x on a typed pill gives the word back; Esc dismisses a suggestion', () => {
		let s = reduce(INITIAL_SEARCH_STATE, { type: 'text', text: 'hans loop' })
		s = reduce(s, { type: 'dismiss' })
		expect(suggest(s.parts, vocab)).toBeNull()
		s = reduce(INITIAL_SEARCH_STATE, { type: 'text', text: 'hans loop' })
		s = reduce(s, { type: 'accept' })
		s = reduce(s, { type: 'removePill', index: 0 })
		expect(queryText(s.parts)).toBe('hans loop')
	})

	it('Clear filters drops pills and Updated but keeps the words and the sort', () => {
		let s = reduce(INITIAL_SEARCH_STATE, { type: 'text', text: 'hans' })
		s = reduce(s, { type: 'toggleType', value: 'bet' })
		s = reduce(s, { type: 'setUpdated', value: 'week' })
		s = reduce(s, { type: 'setSort', value: 'az' })
		s = reduce(s, { type: 'clearFilters' })
		expect(s.parts.pills).toEqual([])
		expect(s.updated).toBe('')
		expect(s.sort).toBe('az')
		expect(queryText(s.parts)).toBe('hans')
	})

	it('hydrate puts pills before the text, and ignores the URL echoing our own state', () => {
		const s = reduce(INITIAL_SEARCH_STATE, {
			type: 'hydrate',
			state: { ...EMPTY_URL_STATE, text: 'hans', types: ['loop'], sort: 'recent' },
		})
		expect(s.parts.pills.map((p) => p.value)).toEqual(['loop'])
		expect(s.sort).toBe('recent')

		// A pill made by typing remembers its word; the URL echo must not wipe that.
		let typed = reduce(INITIAL_SEARCH_STATE, { type: 'text', text: 'hans loop' })
		typed = reduce(typed, { type: 'accept' })
		const echo = reduce(typed, {
			type: 'hydrate',
			state: { ...EMPTY_URL_STATE, text: 'hans', types: ['loop'] },
		})
		expect(echo).toBe(typed)
		expect(echo.parts.pills[0].word).toBe('loop')

		const changed = reduce(typed, { type: 'hydrate', state: { ...EMPTY_URL_STATE, text: 'x' } })
		expect(changed.parts.pills).toEqual([])
	})
})
