import { EMPTY_PARTS, addPill, queryText } from '@/lib/search/parts'
import {
	EMPTY_URL_STATE,
	parseSearchState,
	partsFromUrlState,
	serializeSearchState,
	urlStateFromParts,
} from '@/lib/search/url-state'
import { describe, expect, it } from 'vitest'

describe('search url state', () => {
	it('round-trips pills, text, updated and sort', () => {
		let parts = { ...EMPTY_PARTS, text: 'hans' }
		parts = addPill(parts, { kind: 'type', value: 'loop', word: 'loop' })
		parts = addPill(parts, { kind: 'type', value: 'company' })
		parts = addPill(parts, { kind: 'status', value: 'in_progress' })
		const state = urlStateFromParts(parts, 'week', 'recent')

		const params = serializeSearchState(state)
		expect(params).toEqual({
			q: 'hans',
			types: 'loop,company',
			statuses: 'in_progress',
			updated: 'week',
			sort: 'recent',
		})

		const back = parseSearchState(params)
		expect(back).toEqual(state)
		const hydrated = partsFromUrlState(back)
		expect(hydrated.pills.map((p) => `${p.kind}:${p.value}`)).toEqual([
			'type:loop',
			'type:company',
			'status:in_progress',
		])
		expect(queryText(hydrated)).toBe('hans')
	})

	it('leaves defaults out of the URL', () => {
		expect(serializeSearchState(EMPTY_URL_STATE)).toEqual({})
		expect(serializeSearchState({ ...EMPTY_URL_STATE, text: '  ' })).toEqual({})
	})

	it('ignores the legacy type, status and group params without error', () => {
		const parsed = parseSearchState({ q: 'acme', type: 'bet', status: 'done', group: 'objects' })
		expect(parsed).toEqual({ ...EMPTY_URL_STATE, text: 'acme' })
		expect(() => parseSearchState({ status: 'done' })).not.toThrow()
	})

	it('drops invalid values instead of throwing', () => {
		const parsed = parseSearchState({
			q: 42,
			types: ['loop'],
			statuses: 'done,bogus, ,done',
			updated: 'yesterday',
			sort: 'oldest',
		})
		expect(parsed).toEqual({ ...EMPTY_URL_STATE, statuses: ['done'] })
	})

	it('round-trips participants and drops anything that is not an actor id', () => {
		const a = '00000000-0000-4000-8000-0000000000a1'
		const b = '00000000-0000-4000-8000-0000000000a2'
		let parts = { ...EMPTY_PARTS, text: 'pricing' }
		parts = addPill(parts, { kind: 'participant', value: a })
		parts = addPill(parts, { kind: 'participant', value: b })
		const state = urlStateFromParts(parts, '', 'rel')
		const params = serializeSearchState(state)
		expect(params).toEqual({ q: 'pricing', participants: `${a},${b}` })
		expect(parseSearchState(params)).toEqual(state)
		expect(partsFromUrlState(state).pills.map((p) => `${p.kind}:${p.value}`)).toEqual([
			`participant:${a}`,
			`participant:${b}`,
		])
		expect(parseSearchState({ participants: `nope,${a}` }).participants).toEqual([a])
		expect(parseSearchState({ participants: Array(9).fill(a).join(',') }).participants).toEqual([a])
		const six = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000010${i}`)
		expect(parseSearchState({ participants: six.join(',') }).participants).toEqual(six.slice(0, 5))
	})

	it('caps very long text and keeps type keys it does not know', () => {
		expect(parseSearchState({ q: 'x'.repeat(500) }).text).toHaveLength(200)
		expect(parseSearchState({ types: 'loop,future_type' }).types).toEqual(['loop', 'future_type'])
	})
})
