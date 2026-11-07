import { summarizeOpenComments } from '@/lib/file-review-summary'
import { describe, expect, it } from 'vitest'

function comment(
	page: number | null,
	over: Partial<{ parentId: string | null; resolvedAt: string | null }> = {},
) {
	return { parentId: null, resolvedAt: null, page, ...over }
}

describe('summarizeOpenComments', () => {
	it('says nothing is open when the list is empty', () => {
		expect(summarizeOpenComments([])).toBe('Nothing open')
	})

	it('names the page, one-based, when every open comment is on it', () => {
		expect(summarizeOpenComments([comment(2), comment(2)])).toBe('2 comments on page 3')
	})

	it('uses the singular for one comment', () => {
		expect(summarizeOpenComments([comment(0)])).toBe('1 comment on page 1')
	})

	it('gives only the count when comments sit on different pages', () => {
		expect(summarizeOpenComments([comment(0), comment(1)])).toBe('2 comments')
	})

	it('gives only the count for unpaged comments', () => {
		expect(summarizeOpenComments([comment(null)])).toBe('1 comment')
	})

	it('ignores resolved comments and replies', () => {
		expect(
			summarizeOpenComments([
				comment(1),
				comment(1, { resolvedAt: 'x' }),
				comment(5, { parentId: 'p' }),
			]),
		).toBe('1 comment on page 2')
	})
})
