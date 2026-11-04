import {
	askRowTitle,
	emptyStateText,
	findChiefOfStaff,
	searchRowSub,
	shouldOfferAsk,
} from '@/lib/palette/ask'
import { describe, expect, it } from 'vitest'

describe('shouldOfferAsk', () => {
	it('offers it for three or more words', () => {
		expect(shouldOfferAsk('what changed today', true)).toBe(true)
		expect(shouldOfferAsk('what changed', true)).toBe(false)
	})

	it('offers it when the query ends with a question mark', () => {
		expect(shouldOfferAsk('billing?', true)).toBe(true)
	})

	it('offers it when nothing matches', () => {
		expect(shouldOfferAsk('zzz', false)).toBe(true)
		expect(shouldOfferAsk('zzz', true)).toBe(false)
	})

	it('never offers it for an empty query', () => {
		expect(shouldOfferAsk('   ', false)).toBe(false)
	})
})

describe('wording', () => {
	it('quotes the trimmed query', () => {
		expect(askRowTitle(' hello there ')).toBe('Ask Chief of Staff: “hello there”')
		expect(emptyStateText('zzz')).toBe('Nothing matches “zzz”. Try fewer words, or ask an agent.')
	})

	it('words the Search row for zero, one and many matches', () => {
		expect(searchRowSub(0)).toBe('no matches, try fewer words or other types')
		expect(searchRowSub(1)).toBe('1 match · filterable results')
		expect(searchRowSub(3)).toBe('3 matches · filterable results')
	})
})

describe('findChiefOfStaff', () => {
	it('finds the agent by name and ignores people with the same name', () => {
		const actors = [
			{ id: 'h', type: 'human', name: 'Chief of Staff' },
			{ id: 'a', type: 'agent', name: 'Chief of Staff' },
		]
		expect(findChiefOfStaff(actors)?.id).toBe('a')
		expect(findChiefOfStaff([{ id: 'x', type: 'agent', name: 'Strategist' }])).toBeUndefined()
		expect(findChiefOfStaff(undefined)).toBeUndefined()
	})
})
