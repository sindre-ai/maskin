import { normalizeFileTag, sortTagsAlphabetically } from '@/lib/file-tags'
import { describe, expect, it } from 'vitest'

describe('normalizeFileTag', () => {
	it('trims and lowercases, so B-roll and b-roll are one tag', () => {
		expect(normalizeFileTag('  B-Roll ')).toBe('b-roll')
	})

	it('refuses what the server refuses: blank, a comma, over 60 characters', () => {
		expect(normalizeFileTag('   ')).toBeNull()
		expect(normalizeFileTag('a,b')).toBeNull()
		expect(normalizeFileTag('x'.repeat(61))).toBeNull()
		expect(normalizeFileTag('x'.repeat(60))).toBe('x'.repeat(60))
	})
})

describe('sortTagsAlphabetically', () => {
	it('sorts A to Z and leaves the input alone', () => {
		const input = ['interview', 'B-roll', 'audio']
		expect(sortTagsAlphabetically(input)).toEqual(['audio', 'B-roll', 'interview'])
		expect(input[0]).toBe('interview')
		expect(
			sortTagsAlphabetically([
				{ tag: 'b', count: 9 },
				{ tag: 'a', count: 1 },
			]).map((c) => c.tag),
		).toEqual(['a', 'b'])
	})
})
