import { describe, expect, it } from 'vitest'
import {
	applyLoopView,
	normalizeLoopViewName,
	readLoopViews,
	toLoopViewsMetadata,
} from '../../loops/loop-views'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

describe('readLoopViews', () => {
	it('returns no views when none are pinned', () => {
		expect(readLoopViews({})).toEqual([])
		expect(readLoopViews(null)).toEqual([])
	})

	it('reads views in tab order', () => {
		expect(
			readLoopViews({
				views: [
					{ name: 'Results', file_id: A },
					{ name: 'Pipeline', file_id: B },
				],
			}),
		).toEqual([
			{ name: 'Results', fileId: A },
			{ name: 'Pipeline', fileId: B },
		])
	})

	it('reads a legacy view_file_id as one view named Custom view', () => {
		expect(readLoopViews({ view_file_id: A })).toEqual([{ name: 'Custom view', fileId: A }])
	})

	it('prefers views over the legacy id, even when views is empty', () => {
		expect(readLoopViews({ views: [], view_file_id: A })).toEqual([])
		expect(readLoopViews({ views: [{ name: 'Results', file_id: B }], view_file_id: A })).toEqual([
			{ name: 'Results', fileId: B },
		])
	})

	it('skips malformed entries', () => {
		expect(readLoopViews({ views: [{ name: 'x' }, null, { name: 'ok', file_id: A }] })).toEqual([
			{ name: 'ok', fileId: A },
		])
	})
})

describe('applyLoopView', () => {
	const base = [
		{ name: 'Results', fileId: A },
		{ name: 'Pipeline', fileId: B },
	]

	it('adds a new name at the end', () => {
		expect(applyLoopView(base, 'Cost', C)).toEqual([...base, { name: 'Cost', fileId: C }])
	})

	it('replaces the file of an existing name in place', () => {
		expect(applyLoopView(base, 'results', C)).toEqual([
			{ name: 'Results', fileId: C },
			{ name: 'Pipeline', fileId: B },
		])
	})

	it('removes a tab with a null file', () => {
		expect(applyLoopView(base, 'Results', null)).toEqual([{ name: 'Pipeline', fileId: B }])
	})

	it('removing a name that is not there changes nothing', () => {
		expect(applyLoopView(base, 'Nope', null)).toEqual(base)
	})
})

describe('normalizeLoopViewName', () => {
	it('trims', () => expect(normalizeLoopViewName('  Results ')).toBe('Results'))
	it('rejects empty', () => expect(() => normalizeLoopViewName('   ')).toThrow())
	it('rejects over 30 characters', () => {
		expect(normalizeLoopViewName('a'.repeat(30))).toHaveLength(30)
		expect(() => normalizeLoopViewName('a'.repeat(31))).toThrow()
	})
})

describe('toLoopViewsMetadata', () => {
	it('writes snake_case file ids', () => {
		expect(toLoopViewsMetadata([{ name: 'Results', fileId: A }])).toEqual([
			{ name: 'Results', file_id: A },
		])
	})
})
