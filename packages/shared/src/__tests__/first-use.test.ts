import { describe, expect, it } from 'vitest'
import {
	FIRST_USE_PAGES,
	firstUseIntroComments,
	firstUseSuggestionComments,
} from '../constants/first-use'
import { commentRefSchema } from '../schemas/events'

describe('firstUseIntroComments', () => {
	it('greets the reader by first name only', () => {
		const [first] = firstUseIntroComments({ ownerName: 'Charlie Brown', agentsWorking: true })
		expect(first?.content).toContain('Welcome, Charlie.')
		expect(first?.content).not.toContain('Charlie Brown')
	})

	it('falls back to the whole name when there is no space in it', () => {
		const [first] = firstUseIntroComments({ ownerName: 'Charlie', agentsWorking: true })
		expect(first?.content).toContain('Welcome, Charlie.')
	})

	it('offers every product surface as a page ref chip', () => {
		const comments = firstUseIntroComments({ ownerName: 'Ada', agentsWorking: true })
		const refs = comments.flatMap((c) => c.refs ?? [])
		expect(refs.map((r) => r.label)).toEqual(FIRST_USE_PAGES.map((p) => p.label))
		for (const ref of refs) {
			expect(ref.kind).toBe('page')
			// Every page chip expands rather than only navigating.
			expect(ref.detail).toBeTruthy()
		}
	})

	it('only promises agents are working when a session will actually run', () => {
		const working = firstUseIntroComments({ ownerName: 'Ada', agentsWorking: true })
		const alone = firstUseIntroComments({ ownerName: 'Ada', agentsWorking: false })
		expect(working[1]?.content).toContain('Two agents are working')
		expect(alone[1]?.content).not.toContain('Two agents are working')
	})

	it('emits refs the API would accept', () => {
		const refs = firstUseIntroComments({ ownerName: 'Ada', agentsWorking: true }).flatMap(
			(c) => c.refs ?? [],
		)
		for (const ref of refs) expect(() => commentRefSchema.parse(ref)).not.toThrow()
	})

	it('scores the introduction above the suggestions so it leads the queue', () => {
		const intro = firstUseIntroComments({ ownerName: 'Ada', agentsWorking: true })
		const suggestions = firstUseSuggestionComments({ suggestions: [] })
		const introScore = Math.max(...intro.map((c) => c.attention))
		const suggestionScore = Math.max(...suggestions.map((c) => c.attention))
		expect(introScore).toBeGreaterThan(suggestionScore)
		// Both stay on the 1-5 scale the API validates.
		for (const c of [...intro, ...suggestions]) {
			expect(c.attention).toBeGreaterThanOrEqual(1)
			expect(c.attention).toBeLessThanOrEqual(5)
		}
	})
})

describe('firstUseSuggestionComments', () => {
	const suggestions = [
		{
			id: 'a1b2c3d4-0000-4000-8000-000000000001',
			name: 'Discover & Research Loop',
			description: 'Clusters customer signal into insights.',
		},
		{
			id: 'a1b2c3d4-0000-4000-8000-000000000002',
			name: 'Build & Ship Loop',
			description: 'Moves tasks from todo to shipped.',
		},
	]

	it('links each suggestion to its marketplace detail page', () => {
		const [card] = firstUseSuggestionComments({ suggestions })
		expect(card?.refs?.map((r) => r.path)).toEqual([
			`marketplace/${suggestions[0]?.id}`,
			`marketplace/${suggestions[1]?.id}`,
		])
		expect(card?.refs?.every((r) => r.tag === 'LOOP')).toBe(true)
	})

	it('carries each loop’s real description as the expandable detail', () => {
		const [card] = firstUseSuggestionComments({ suggestions })
		expect(card?.refs?.map((r) => r.detail)).toEqual([
			suggestions[0]?.description,
			suggestions[1]?.description,
		])
	})

	it('asks the reader what they want before recommending anything', () => {
		const comments = firstUseSuggestionComments({ suggestions })
		const ask = comments[comments.length - 1]
		expect(ask?.content).toContain('What are you hoping to get out of this?')
		expect(ask?.chips?.length).toBeGreaterThan(0)
	})

	it('degrades to a marketplace pointer when the catalog is empty', () => {
		const comments = firstUseSuggestionComments({ suggestions: [] })
		expect(comments).toHaveLength(1)
		expect(comments[0]?.refs?.[0]?.path).toBe('marketplace')
		// Never claims loops exist when none do.
		expect(comments[0]?.content).not.toContain('already wired')
	})

	it('agrees in number with a single suggestion', () => {
		const [card] = firstUseSuggestionComments({ suggestions: suggestions.slice(0, 1) })
		expect(card?.content).toContain('This one is')
	})

	it('emits refs the API would accept', () => {
		const refs = firstUseSuggestionComments({ suggestions }).flatMap((c) => c.refs ?? [])
		for (const ref of refs) expect(() => commentRefSchema.parse(ref)).not.toThrow()
	})
})
