import { applyWord, explainEmpty, findFilterWords } from '@/lib/search/empty-state'
import { EMPTY_PARTS, type SearchParts, queryText } from '@/lib/search/parts'
import { describe, expect, it } from 'vitest'
import { vocab } from './fixtures'

const withText = (text: string, pills: SearchParts['pills'] = []): SearchParts => ({
	...EMPTY_PARTS,
	pills,
	text,
})

const noRelaxed = { withoutFilters: 0, withoutStatuses: 0 }

describe('findFilterWords', () => {
	it('finds a status word in the text', () => {
		const hits = findFilterWords(withText('hans active'), vocab)
		expect(hits).toMatchObject([{ kind: 'status', value: 'in_progress', word: 'active' }])
	})

	it('finds a type word and a two-word status together, in typed order', () => {
		const hits = findFilterWords(withText('acme loop needs you'), vocab)
		expect(hits.map((h) => [h.kind, h.value, h.word])).toEqual([
			['type', 'loop', 'loop'],
			['status', 'needs_you', 'needs you'],
		])
	})

	it('skips quoted words and words that are already pills', () => {
		expect(findFilterWords(withText('"active" hans'), vocab)).toEqual([])
		const pilled = withText('active', [{ kind: 'status', value: 'in_progress' }])
		expect(findFilterWords(pilled, vocab)).toEqual([])
	})

	it('finds nothing in plain words', () => {
		expect(findFilterWords(withText('hans meeting notes'), vocab)).toEqual([])
	})
})

describe('applyWord', () => {
	it('moves the word into a pill that remembers it, and leaves the other words', () => {
		const parts = withText('hans active')
		const [hit] = findFilterWords(parts, vocab)
		const next = applyWord(parts, hit)
		expect(next.pills).toEqual([{ kind: 'status', value: 'in_progress', word: 'active' }])
		expect(queryText(next)).toBe('hans')
	})

	it('removes a two-word phrase as one unit', () => {
		const parts = withText('hans needs you now')
		const [hit] = findFilterWords(parts, vocab)
		expect(queryText(applyWord(parts, hit))).toBe('hans now')
	})
})

describe('explainEmpty', () => {
	it('names a status word and offers its chip when the query finds nothing', () => {
		const e = explainEmpty({
			parts: withText('hans active'),
			vocab,
			updated: '',
			relaxed: noRelaxed,
		})
		expect(e.title).toBe('Nothing matches “hans active”')
		expect(e.wordNotes).toEqual(['“active” is a status. Pick a type first, then choose a status.'])
		expect(e.hits.map((h) => h.label)).toEqual(['In progress'])
		expect(e.filtered).toBe(false)
		expect(e.everything).toBe(0)
	})

	it('names a type word too', () => {
		const e = explainEmpty({ parts: withText('hans loop'), vocab, updated: '', relaxed: noRelaxed })
		expect(e.wordNotes[0]).toContain('“loop” is a type')
		expect(e.hits.map((h) => h.label)).toEqual(['Loops'])
	})

	it('says a filter emptied the list and offers the wider counts', () => {
		const e = explainEmpty({
			parts: withText('hans', [{ kind: 'status', value: 'done' }]),
			vocab,
			updated: '',
			relaxed: { withoutFilters: 7, withoutStatuses: 3 },
		})
		expect(e.title).toBe('No results with these filters')
		expect(e.filtered).toBe(true)
		expect(e.everything).toBe(7)
		expect(e.withoutStatuses).toBe(3)
	})

	it('counts an Updated window as a filter', () => {
		const e = explainEmpty({
			parts: withText('hans'),
			vocab,
			updated: 'day',
			relaxed: { withoutFilters: 2, withoutStatuses: 2 },
		})
		expect(e.filtered).toBe(true)
		expect(e.withoutStatuses).toBeNull()
	})

	it('has nothing to name for plain words', () => {
		const e = explainEmpty({ parts: withText('zzzz'), vocab, updated: '', relaxed: noRelaxed })
		expect(e.wordNotes).toEqual([])
		expect(e.hits).toEqual([])
	})
})
