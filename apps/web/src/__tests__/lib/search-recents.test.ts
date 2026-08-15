import { beforeEach, describe, expect, it } from 'vitest'

import {
	getRecentObjectIds,
	getRecentSearches,
	pushRecentObject,
	pushRecentSearch,
} from '@/lib/search-recents'

const wsA = 'ws-a'
const wsB = 'ws-b'

beforeEach(() => {
	localStorage.clear()
})

describe('pushRecentSearch / getRecentSearches', () => {
	it('stores the most recent query first', () => {
		pushRecentSearch(wsA, 'docs')
		pushRecentSearch(wsA, 'bets')

		expect(getRecentSearches(wsA)).toEqual(['bets', 'docs'])
	})

	it('dedupes a repeated query and moves it to the front', () => {
		pushRecentSearch(wsA, 'bets')
		pushRecentSearch(wsA, 'docs')
		pushRecentSearch(wsA, 'bets')

		expect(getRecentSearches(wsA)).toEqual(['bets', 'docs'])
	})

	it('caps the list at six entries, dropping the oldest', () => {
		for (let i = 0; i < 8; i++) pushRecentSearch(wsA, `q${i}`)

		expect(getRecentSearches(wsA)).toHaveLength(6)
		expect(getRecentSearches(wsA)[0]).toBe('q7')
	})

	it('ignores blank queries', () => {
		pushRecentSearch(wsA, '   ')

		expect(getRecentSearches(wsA)).toEqual([])
	})

	it('scopes recents per workspace', () => {
		pushRecentSearch(wsA, 'docs')
		pushRecentSearch(wsB, 'agents')

		expect(getRecentSearches(wsA)).toEqual(['docs'])
		expect(getRecentSearches(wsB)).toEqual(['agents'])
	})
})

describe('pushRecentObject / getRecentObjectIds', () => {
	it('stores the most recently opened object first', () => {
		pushRecentObject(wsA, 'obj-1')
		pushRecentObject(wsA, 'obj-2')

		expect(getRecentObjectIds(wsA)).toEqual(['obj-2', 'obj-1'])
	})

	it('dedupes and caps at four entries', () => {
		for (let i = 0; i < 6; i++) pushRecentObject(wsA, `obj-${i}`)
		pushRecentObject(wsA, 'obj-3')

		expect(getRecentObjectIds(wsA)).toEqual(['obj-3', 'obj-5', 'obj-4', 'obj-2'])
	})

	it('ignores empty ids', () => {
		pushRecentObject(wsA, '')

		expect(getRecentObjectIds(wsA)).toEqual([])
	})
})
