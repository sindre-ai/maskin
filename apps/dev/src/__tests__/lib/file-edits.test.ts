import { describe, expect, it } from 'vitest'
import { FileEditError, applyFileEdits } from '../../lib/file-save'

describe('applyFileEdits', () => {
	it('replaces text that occurs exactly once', () => {
		expect(applyFileEdits('a b c', [{ old: 'b', new: 'X' }])).toBe('a X c')
	})

	it('applies edits in order, each to the result of the one before', () => {
		const out = applyFileEdits('one', [
			{ old: 'one', new: 'two' },
			{ old: 'two', new: 'three' },
		])
		expect(out).toBe('three')
	})

	it('fails with no_match when the text is absent, naming the edit', () => {
		expect(() =>
			applyFileEdits('abc', [
				{ old: 'a', new: 'x' },
				{ old: 'zzz', new: 'y' },
			]),
		).toThrowError(expect.objectContaining({ reason: 'no_match', editIndex: 1, matches: 0 }))
	})

	it('fails with multiple_matches and the count when old is not unique', () => {
		expect(() => applyFileEdits('a a a', [{ old: 'a', new: 'b' }])).toThrowError(
			expect.objectContaining({ reason: 'multiple_matches', editIndex: 0, matches: 3 }),
		)
		expect(() => applyFileEdits('a a', [{ old: 'a', new: 'b' }])).toThrow(FileEditError)
	})

	it('replaces every occurrence with replace_all', () => {
		expect(applyFileEdits('a a a', [{ old: 'a', new: 'b', replace_all: true }])).toBe('b b b')
	})

	it('treats the replacement literally, with no $ patterns', () => {
		expect(applyFileEdits('price', [{ old: 'price', new: '$& $1 $$' }])).toBe('$& $1 $$')
	})

	it('allows deleting text with an empty replacement', () => {
		expect(applyFileEdits('keep drop keep', [{ old: ' drop', new: '' }])).toBe('keep keep')
	})

	it('does not count overlapping matches twice', () => {
		expect(() => applyFileEdits('aaa', [{ old: 'aa', new: 'b' }])).not.toThrow()
	})
})
