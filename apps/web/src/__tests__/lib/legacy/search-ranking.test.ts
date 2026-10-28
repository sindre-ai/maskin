import { type SearchRow, rankTitleMatchesFirst } from '@/hooks/legacy/use-workspace-search'
import { describe, expect, it } from 'vitest'

function row(title: string): SearchRow {
	return {
		id: title,
		group: 'objects',
		kind: 'INSIGHT',
		title,
		sub: '',
		snippet: '',
		to: '/$workspaceId/objects/$objectId',
		params: {},
	}
}

const rank = (query: string, titles: string[]) =>
	rankTitleMatchesFirst(titles.map(row), query).map((r) => r.title)

describe('rankTitleMatchesFirst', () => {
	it('puts names that continue the typed phrase before shorter names that do not', () => {
		expect(rank('Anna B', ['Anna Eve', 'Anna Fox', 'Anna Brandtsen', 'Anna Baker'])).toEqual([
			'Anna Baker',
			'Anna Brandtsen',
			'Anna Eve',
			'Anna Fox',
		])
	})

	it('still ranks an exact title above a longer one that starts with it', () => {
		expect(rank('hans', ['Hans Solutions', 'Hans'])).toEqual(['Hans', 'Hans Solutions'])
	})

	it('keeps content-only matches after title matches', () => {
		expect(rank('anna', ['Weekly notes', 'Anna Eve'])).toEqual(['Anna Eve', 'Weekly notes'])
	})
})
