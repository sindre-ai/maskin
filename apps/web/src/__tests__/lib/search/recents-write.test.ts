import { getRecentSearchEntries, pushRecentSearchEntry } from '@/lib/search/recents'
import { beforeEach, describe, expect, it } from 'vitest'

const KEY = 'maskin-recent-searches-ws-1'

beforeEach(() => {
	localStorage.clear()
})

describe('pushRecentSearchEntry', () => {
	it('stores words and pills, newest first', () => {
		pushRecentSearchEntry('ws-1', { q: 'hans', types: ['loop'], statuses: ['done'] })
		pushRecentSearchEntry('ws-1', { q: 'acme', types: [], statuses: [] })
		expect(getRecentSearchEntries('ws-1')).toEqual([
			{ q: 'acme', types: [], statuses: [] },
			{ q: 'hans', types: ['loop'], statuses: ['done'] },
		])
	})

	it('moves a repeated search to the front instead of repeating it', () => {
		pushRecentSearchEntry('ws-1', { q: 'hans', types: [], statuses: [] })
		pushRecentSearchEntry('ws-1', { q: 'acme', types: [], statuses: [] })
		pushRecentSearchEntry('ws-1', { q: 'hans', types: [], statuses: [] })
		expect(getRecentSearchEntries('ws-1').map((r) => r.q)).toEqual(['hans', 'acme'])
	})

	it('keeps the same words with different pills as separate searches', () => {
		pushRecentSearchEntry('ws-1', { q: 'hans', types: [], statuses: [] })
		pushRecentSearchEntry('ws-1', { q: 'hans', types: ['loop'], statuses: [] })
		expect(getRecentSearchEntries('ws-1')).toHaveLength(2)
	})

	it('keeps at most five', () => {
		for (const q of ['a', 'b', 'c', 'd', 'e', 'f']) {
			pushRecentSearchEntry('ws-1', { q, types: [], statuses: [] })
		}
		expect(getRecentSearchEntries('ws-1').map((r) => r.q)).toEqual(['f', 'e', 'd', 'c', 'b'])
	})

	it('ignores an empty search', () => {
		pushRecentSearchEntry('ws-1', { q: '  ', types: [], statuses: [] })
		expect(localStorage.getItem(KEY)).toBeNull()
	})

	it('leaves the old strings in the list readable', () => {
		localStorage.setItem(KEY, JSON.stringify(['legacy words']))
		pushRecentSearchEntry('ws-1', { q: 'hans', types: ['loop'], statuses: [] })
		expect(getRecentSearchEntries('ws-1').map((r) => r.q)).toEqual(['hans', 'legacy words'])
	})
})
