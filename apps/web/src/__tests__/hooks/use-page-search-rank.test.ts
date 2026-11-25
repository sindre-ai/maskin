import { sortByRank } from '@/hooks/use-page-search-rank'
import { describe, expect, it } from 'vitest'

const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
const idOf = (row: { id: string }) => row.id

describe('sortByRank', () => {
	it('keeps the given order when there is no ranking', () => {
		expect(sortByRank(rows, null, idOf)).toEqual(rows)
	})

	it('puts ranked rows first in the ranked order', () => {
		const rank = new Map([
			['c', 0],
			['a', 1],
		])
		expect(sortByRank(rows, rank, idOf).map(idOf)).toEqual(['c', 'a', 'b', 'd'])
	})

	it('keeps unranked rows in their given order after the ranked ones', () => {
		const rank = new Map([['d', 0]])
		expect(sortByRank(rows, rank, idOf).map(idOf)).toEqual(['d', 'a', 'b', 'c'])
	})
})
