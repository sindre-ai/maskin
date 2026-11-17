import {
	isSlideDeck,
	jumpToBriefing,
	stepStory,
	storyFill,
	storyPageCount,
} from '@/lib/briefing-sequence'
import { describe, expect, it } from 'vitest'

const deck = (slides: number) =>
	`<html><body>${'<section class="slide"></section>'.repeat(slides)}</body></html>`

describe('storyPageCount', () => {
	it('counts a deck by its slides', () => {
		expect(storyPageCount(deck(6))).toBe(6)
	})

	it('counts a page that is not a deck as one page', () => {
		expect(storyPageCount('<h1>Daily briefing</h1><p>No slides here.</p>')).toBe(1)
		expect(storyPageCount(undefined)).toBe(1)
	})
})

describe('isSlideDeck', () => {
	it('tells a deck from a plain page', () => {
		expect(isSlideDeck(deck(2))).toBe(true)
		expect(isSlideDeck('<h1>Plain</h1>')).toBe(false)
		expect(isSlideDeck(undefined)).toBe(false)
	})
})

describe('stepStory', () => {
	const counts = [3, 1, 2]

	it('moves one slide inside a briefing', () => {
		expect(stepStory(counts, { index: 0, slide: 0 }, 1)).toEqual({ index: 0, slide: 1 })
		expect(stepStory(counts, { index: 0, slide: 2 }, -1)).toEqual({ index: 0, slide: 1 })
	})

	it('goes from the last slide to the first slide of the next briefing', () => {
		expect(stepStory(counts, { index: 0, slide: 2 }, 1)).toEqual({ index: 1, slide: 0 })
	})

	it('goes from the first slide to the last slide of the previous briefing', () => {
		expect(stepStory(counts, { index: 2, slide: 0 }, -1)).toEqual({ index: 1, slide: 0 })
		expect(stepStory(counts, { index: 1, slide: 0 }, -1)).toEqual({ index: 0, slide: 2 })
	})

	it('steps straight over a page that is not a deck', () => {
		expect(stepStory(counts, { index: 1, slide: 0 }, 1)).toEqual({ index: 2, slide: 0 })
	})

	it('stops at both ends of the sequence', () => {
		expect(stepStory(counts, { index: 0, slide: 0 }, -1)).toBeNull()
		expect(stepStory(counts, { index: 2, slide: 1 }, 1)).toBeNull()
	})

	it('walks every slide of every briefing in order and back', () => {
		const forward = [{ index: 0, slide: 0 }]
		for (let next = stepStory(counts, forward[0], 1); next; next = stepStory(counts, next, 1)) {
			forward.push(next)
		}
		expect(forward).toEqual([
			{ index: 0, slide: 0 },
			{ index: 0, slide: 1 },
			{ index: 0, slide: 2 },
			{ index: 1, slide: 0 },
			{ index: 2, slide: 0 },
			{ index: 2, slide: 1 },
		])
		const back = [forward[forward.length - 1]]
		for (let prev = stepStory(counts, back[0], -1); prev; prev = stepStory(counts, prev, -1)) {
			back.push(prev)
		}
		expect(back).toEqual([...forward].reverse())
	})
})

describe('jumpToBriefing', () => {
	it('opens the chosen briefing on its first slide', () => {
		expect(jumpToBriefing([3, 1, 2], 2)).toEqual({ index: 2, slide: 0 })
	})

	it('keeps the index inside the row', () => {
		expect(jumpToBriefing([3, 1, 2], 9)).toEqual({ index: 2, slide: 0 })
		expect(jumpToBriefing([3, 1, 2], -1)).toEqual({ index: 0, slide: 0 })
	})
})

describe('storyFill', () => {
	it('fills the briefings before the open one, part-fills the open one and leaves the rest empty', () => {
		expect(storyFill([4, 6, 1], { index: 1, slide: 2 })).toEqual([1, 0.5, 0])
	})

	it('fills a page that is not a deck once it is open', () => {
		expect(storyFill([4, 1], { index: 1, slide: 0 })).toEqual([1, 1])
	})
})
