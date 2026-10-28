import { getRecentSearchEntries, normalizeRecentSearch } from '@/lib/search/recents'
import { beforeEach, describe, expect, it } from 'vitest'

const KEY = 'maskin-recent-searches-ws1'

describe('recent searches reader', () => {
	beforeEach(() => localStorage.clear())

	it('accepts legacy strings and new objects in the same list', () => {
		localStorage.setItem(
			KEY,
			JSON.stringify(['acme', { q: 'hans', types: ['loop'], statuses: ['done'] }]),
		)
		expect(getRecentSearchEntries('ws1')).toEqual([
			{ q: 'acme', types: [], statuses: [] },
			{ q: 'hans', types: ['loop'], statuses: ['done'] },
		])
	})

	it('drops entries that are neither shape, and empty ones', () => {
		expect(normalizeRecentSearch(7)).toBeNull()
		expect(normalizeRecentSearch(null)).toBeNull()
		expect(normalizeRecentSearch('  ')).toBeNull()
		expect(normalizeRecentSearch({ q: '', types: [], statuses: [] })).toBeNull()
		expect(normalizeRecentSearch({ types: ['loop', 3, ''] })).toEqual({
			q: '',
			types: ['loop'],
			statuses: [],
		})
	})

	it('returns an empty list for missing, malformed or non-array storage', () => {
		expect(getRecentSearchEntries('ws1')).toEqual([])
		localStorage.setItem(KEY, '{not json')
		expect(getRecentSearchEntries('ws1')).toEqual([])
		localStorage.setItem(KEY, '{"q":"x"}')
		expect(getRecentSearchEntries('ws1')).toEqual([])
	})

	it('keeps at most five and scopes by workspace', () => {
		localStorage.setItem(KEY, JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f']))
		expect(getRecentSearchEntries('ws1')).toHaveLength(5)
		expect(getRecentSearchEntries('ws2')).toEqual([])
	})
})
