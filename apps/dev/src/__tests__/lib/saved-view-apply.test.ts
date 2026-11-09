import { type ViewRow, applySavedView } from '../../lib/saved-view-apply'

const row = (id: string, tags: string[], driverId: string | null = null): ViewRow => ({
	id,
	tags,
	driverId,
})

describe('applySavedView', () => {
	const rows = [
		row('a', ['Sales', 'EU']),
		row('b', ['sales']),
		row('c', []),
		row('d', ['Support'], 'drv-1'),
	]

	it('with no filter and no group-by returns everything in one unkeyed group, in order', () => {
		expect(applySavedView(rows, { filter: {}, groupBy: null })).toEqual([
			{ key: null, ids: ['a', 'b', 'c', 'd'] },
		])
	})

	it('keeps rows that carry every filter tag, ignoring capitalisation', () => {
		expect(applySavedView(rows, { filter: { tags: ['SALES'] }, groupBy: null })).toEqual([
			{ key: null, ids: ['a', 'b'] },
		])
		expect(applySavedView(rows, { filter: { tags: ['sales', 'eu'] }, groupBy: null })).toEqual([
			{ key: null, ids: ['a'] },
		])
	})

	it('groups by tag: a row sits under each of its tags, untagged rows last under a null key', () => {
		expect(applySavedView(rows, { filter: {}, groupBy: 'tag' })).toEqual([
			{ key: 'EU', ids: ['a'] },
			{ key: 'Sales', ids: ['a', 'b'] },
			{ key: 'Support', ids: ['d'] },
			{ key: null, ids: ['c'] },
		])
	})

	it('filters by driver and groups by driver', () => {
		expect(applySavedView(rows, { filter: { driverId: 'drv-1' }, groupBy: null })).toEqual([
			{ key: null, ids: ['d'] },
		])
		expect(applySavedView(rows, { filter: {}, groupBy: 'driver' })).toEqual([
			{ key: 'drv-1', ids: ['d'] },
			{ key: null, ids: ['a', 'b', 'c'] },
		])
	})

	it('returns one empty group when nothing matches and there is no group-by', () => {
		expect(applySavedView(rows, { filter: { tags: ['nope'] }, groupBy: null })).toEqual([
			{ key: null, ids: [] },
		])
	})

	it('returns no groups when nothing matches and there is a group-by', () => {
		expect(applySavedView(rows, { filter: { tags: ['nope'] }, groupBy: 'tag' })).toEqual([])
	})
})
