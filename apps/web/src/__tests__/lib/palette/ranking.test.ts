import { initialsMatch, matches, rankTitleMatchesFirst } from '@/lib/palette/ranking'
import { describe, expect, it } from 'vitest'

describe('matches', () => {
	it('finds a row when the words come in reverse order', () => {
		expect(matches('baker anna', 'Anna Baker')).toBe(true)
	})

	it('needs every word, and looks in every field', () => {
		expect(matches('billing chief', 'Billing catch-up', 'Chief of Staff')).toBe(true)
		expect(matches('billing zebra', 'Billing catch-up', 'Chief of Staff')).toBe(false)
	})

	it('forgives a typo in a longer word', () => {
		expect(matches('mgnus', 'Magnus')).toBe(true)
	})
})

describe('initialsMatch', () => {
	it('matches the initials of a title from two letters', () => {
		expect(initialsMatch('nc', 'New chat')).toBe(true)
		expect(initialsMatch('NC', 'New chat')).toBe(true)
		expect(initialsMatch('mar', 'Mark all read')).toBe(true)
	})

	it('ignores a single letter, other letters and non-letters', () => {
		expect(initialsMatch('n', 'New chat')).toBe(false)
		expect(initialsMatch('nx', 'New chat')).toBe(false)
		expect(initialsMatch('n c', 'New chat')).toBe(false)
		expect(initialsMatch('', 'New chat')).toBe(false)
	})
})

describe('rankTitleMatchesFirst', () => {
	it('ranks any list of titled rows, not only search rows', () => {
		const rows = [{ title: 'Anna Eve' }, { title: 'Anna Baker' }]
		expect(rankTitleMatchesFirst(rows, 'anna b').map((r) => r.title)).toEqual([
			'Anna Baker',
			'Anna Eve',
		])
	})
})
