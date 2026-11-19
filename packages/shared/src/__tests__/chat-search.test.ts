import { describe, expect, it } from 'vitest'
import { CHAT_SEARCH_MAX_PER_FILTER, parseChatSearch } from '../search/chat-search'

describe('parseChatSearch', () => {
	it('reads plain words as text and finds no filter', () => {
		const parsed = parseChatSearch('  budget   review ')
		expect(parsed.text).toBe('budget review')
		expect(parsed.operators).toEqual([])
	})

	it('reads agent, from, with, team and is out of the text', () => {
		const parsed = parseChatSearch(
			'agent:Forge from:Sebastian with:Magnus team:Sales is:unread launch',
		)
		expect(parsed).toMatchObject({
			text: 'launch',
			agent: ['forge'],
			from: ['sebastian'],
			with: ['magnus'],
			team: ['sales'],
			is: ['unread'],
			operators: ['agent', 'from', 'with', 'team', 'is'],
		})
	})

	it('takes a quoted value after a filter name', () => {
		expect(parseChatSearch('from:"Sebastian K" notes')).toMatchObject({
			from: ['sebastian k'],
			text: 'notes',
		})
	})

	it('reads quoted phrases and minus words, and minus phrases', () => {
		const parsed = parseChatSearch('"launch plan" -draft -"old plan" ship')
		expect(parsed.phrases).toEqual(['launch plan'])
		expect(parsed.exclude).toEqual(['draft', 'old plan'])
		expect(parsed.text).toBe('ship')
		expect(parsed.operators).toEqual(['phrase', 'exclude'])
	})

	it('accepts every is: value and keeps an unknown one as plain text', () => {
		const parsed = parseChatSearch('is:needs is:working is:later is:archived is:unread is:nonsense')
		expect(parsed.is).toEqual(['needs', 'working', 'later', 'archived', 'unread'])
		expect(parsed.text).toBe('is:nonsense')
	})

	it('keeps an unknown key, a time and a lone dash as plain text', () => {
		const parsed = parseChatSearch('foo:bar 10:30 - agent:')
		expect(parsed.text).toBe('foo:bar 10:30 - agent:')
		expect(parsed.operators).toEqual([])
	})

	it('is case-insensitive on the filter name and lower-cases the value', () => {
		expect(parseChatSearch('IS:Later From:ME')).toMatchObject({ is: ['later'], from: ['me'] })
	})

	it('lists each filter once however often it is used, in a fixed order', () => {
		const parsed = parseChatSearch('-a is:later from:x from:y "p"')
		expect(parsed.from).toEqual(['x', 'y'])
		expect(parsed.operators).toEqual(['from', 'is', 'phrase', 'exclude'])
	})

	it('reads at most a handful of values per filter', () => {
		const many = Array.from({ length: 20 }, (_, i) => `with:p${i}`).join(' ')
		expect(parseChatSearch(many).with).toHaveLength(CHAT_SEARCH_MAX_PER_FILTER)
	})

	it('handles nothing', () => {
		expect(parseChatSearch(undefined).text).toBe('')
		expect(parseChatSearch('').operators).toEqual([])
	})
})
