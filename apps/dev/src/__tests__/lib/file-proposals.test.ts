import { describe, expect, it } from 'vitest'
import {
	PROPOSAL_CONTEXT_CHARS,
	countOccurrences,
	isChangeStale,
	validateProposedChanges,
} from '../../lib/file-proposals'

const DOC = '# Plan\n\nWe ship on Friday.\n\nThe budget is small.\n\nWe ship on Monday.\n'

describe('countOccurrences', () => {
	it('counts overlapping occurrences', () => {
		expect(countOccurrences('aaa', 'aa')).toBe(2)
	})

	it('is zero for an empty needle', () => {
		expect(countOccurrences('abc', '')).toBe(0)
	})
})

describe('validateProposedChanges', () => {
	it('resolves a unique match with context taken from the file', () => {
		const result = validateProposedChanges(DOC, [
			{ old_text: 'The budget is small.', new_text: 'The budget is tight.' },
		])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const [only] = result.resolved
		expect(only?.start).toBe(DOC.indexOf('The budget is small.'))
		expect(only?.contextBefore).toBe(DOC.slice(0, only?.start).slice(-PROPOSAL_CONTEXT_CHARS))
		expect(only?.contextAfter).toBe('\n\nWe ship on Monday.\n')
	})

	it('rejects a change that matches more than once and names its index', () => {
		const result = validateProposedChanges(DOC, [
			{ old_text: 'The budget is small.', new_text: 'x' },
			{ old_text: 'We ship on', new_text: 'y' },
		])
		expect(result).toEqual({
			ok: false,
			index: 1,
			message: 'old_text matches 2 times, include more surrounding text',
		})
	})

	it('rejects a change that matches nowhere', () => {
		const result = validateProposedChanges(DOC, [{ old_text: 'not here', new_text: 'y' }])
		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.index).toBe(0)
		expect(result.message).toContain('not found')
	})

	it('rejects overlapping changes and names the later one', () => {
		const result = validateProposedChanges(DOC, [
			{ old_text: 'We ship on Friday.\n\nThe budget', new_text: 'a' },
			{ old_text: 'The budget is small.', new_text: 'b' },
		])
		expect(result).toEqual({
			ok: false,
			index: 1,
			message: 'old_text overlaps the text of change 0',
		})
	})

	it('accepts adjacent changes that touch but do not overlap', () => {
		const result = validateProposedChanges('abcdef', [
			{ old_text: 'abc', new_text: 'x' },
			{ old_text: 'def', new_text: 'y' },
		])
		expect(result.ok).toBe(true)
	})

	it('does not cut a surrogate pair in the context', () => {
		// The 40-character window would start on the second half of the emoji.
		const source = `${'x'.repeat(5)}😀${'y'.repeat(PROPOSAL_CONTEXT_CHARS - 1)}target`
		const result = validateProposedChanges(source, [{ old_text: 'target', new_text: 'z' }])
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.resolved[0]?.contextBefore).toBe('y'.repeat(PROPOSAL_CONTEXT_CHARS - 1))
	})
})

describe('isChangeStale', () => {
	it('is fresh while old_text occurs exactly once', () => {
		expect(isChangeStale(DOC, 'The budget is small.')).toBe(false)
	})

	it('is stale when old_text is gone', () => {
		expect(isChangeStale(DOC.replace('small', 'tight'), 'The budget is small.')).toBe(true)
	})

	it('is stale when old_text now occurs twice', () => {
		expect(isChangeStale(`${DOC}The budget is small.\n`, 'The budget is small.')).toBe(true)
	})
})
