import { applyMention, getActiveMention, parseMentionIds } from '@/lib/chat-mentions'
import { describe, expect, it } from 'vitest'

const AGENTS = [
	{ id: 'a1', name: 'Sindre' },
	{ id: 'a2', name: 'Senior Developer' },
	{ id: 'a3', name: 'Dev' },
]

describe('parseMentionIds', () => {
	it('returns ids for names mentioned with @', () => {
		expect(parseMentionIds('hey @Sindre can you help', AGENTS)).toEqual(['a1'])
	})

	it('matches multi-word names and is case-insensitive', () => {
		expect(parseMentionIds('@senior developer please review', AGENTS)).toEqual(['a2'])
	})

	it('prefers the longest matching name over a shared prefix', () => {
		// "Senior Developer" must win over "Dev" even though "Dev" also appears.
		const ids = parseMentionIds('@Senior Developer', AGENTS)
		expect(ids).toEqual(['a2'])
	})

	it('ignores @ that is not on a word boundary (emails)', () => {
		expect(parseMentionIds('mail me at me@Sindre.io', AGENTS)).toEqual([])
	})

	it('dedupes repeated mentions and supports multiple agents', () => {
		expect(parseMentionIds('@Sindre @Dev @Sindre', AGENTS).sort()).toEqual(['a1', 'a3'])
	})

	it('returns empty for empty text', () => {
		expect(parseMentionIds('', AGENTS)).toEqual([])
	})
})

describe('getActiveMention', () => {
	it('detects an in-progress mention at the caret', () => {
		const value = 'hi @Sin'
		expect(getActiveMention(value, value.length)).toEqual({ at: 3, query: 'Sin' })
	})

	it('returns null when the caret is not after an @', () => {
		expect(getActiveMention('hello world', 11)).toBeNull()
	})

	it('returns null when @ follows a non-space char', () => {
		expect(getActiveMention('me@host', 7)).toBeNull()
	})

	it('closes the mention on a newline', () => {
		const value = '@Sindre\nmore'
		expect(getActiveMention(value, value.length)).toBeNull()
	})
})

describe('applyMention', () => {
	it('replaces the active token with a completed mention and trailing space', () => {
		const value = 'hi @Sin'
		const active = getActiveMention(value, value.length)
		expect(active).not.toBeNull()
		if (!active) return
		const result = applyMention(value, active, 'Sindre')
		expect(result.value).toBe('hi @Sindre ')
		expect(result.caret).toBe(result.value.length)
	})

	it('preserves text after the caret', () => {
		const value = 'hi @Sin there'
		const active = getActiveMention(value, 7)
		expect(active).not.toBeNull()
		if (!active) return
		const result = applyMention(value, active, 'Sindre')
		expect(result.value).toBe('hi @Sindre  there')
	})
})
