import { diffLines } from '@/lib/reconcile/diff-lines'
import { describe, expect, it } from 'vitest'

describe('diffLines', () => {
	it('returns identical rows when strings match', () => {
		const rows = diffLines('one\ntwo\nthree', 'one\ntwo\nthree')
		expect(rows).toHaveLength(3)
		expect(rows.every((r) => r.kind === 'both')).toBe(true)
	})

	it('marks lines only in mine', () => {
		const rows = diffLines('a\nb\nc', 'a\nc')
		const mineOnly = rows.filter((r) => r.kind === 'mine')
		expect(mineOnly).toHaveLength(1)
		expect(mineOnly[0].mine).toBe('b')
		expect(mineOnly[0].theirs).toBeNull()
	})

	it('marks lines only in theirs', () => {
		const rows = diffLines('a\nc', 'a\nb\nc')
		const theirsOnly = rows.filter((r) => r.kind === 'theirs')
		expect(theirsOnly).toHaveLength(1)
		expect(theirsOnly[0].theirs).toBe('b')
		expect(theirsOnly[0].mine).toBeNull()
	})

	it('handles empty inputs', () => {
		expect(diffLines('', '')).toEqual([{ kind: 'both', mine: '', theirs: '' }])
	})

	it('handles totally divergent inputs', () => {
		const rows = diffLines('mine only', 'their only')
		expect(rows.some((r) => r.kind === 'mine')).toBe(true)
		expect(rows.some((r) => r.kind === 'theirs')).toBe(true)
		expect(rows.some((r) => r.kind === 'both')).toBe(false)
	})
})
