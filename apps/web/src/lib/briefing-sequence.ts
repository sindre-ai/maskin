/**
 * The For you briefing viewer walks one sequence: every slide of every briefing, in the order the
 * briefings were written. A briefing that is not a slide deck counts as one page. Pure helpers
 * only, so the rules are tested without a browser.
 */

import { VIEWER_SLIDE_SELECTOR } from './mini-app'

/** Where the reader is: which briefing, and which slide of it (both zero-based). */
export interface StoryPosition {
	index: number
	slide: number
}

/** How many slides a page has: a deck's own, else one. Parsed inertly, so nothing in it runs. */
export function storyPageCount(html: string | null | undefined): number {
	if (!html) return 1
	const doc = new DOMParser().parseFromString(html, 'text/html')
	return Math.max(1, doc.querySelectorAll(VIEWER_SLIDE_SELECTOR).length)
}

/** Whether the page has slides of its own to walk (a plain page has none). */
export function isSlideDeck(html: string | null | undefined): boolean {
	if (!html) return false
	return (
		new DOMParser().parseFromString(html, 'text/html').querySelector(VIEWER_SLIDE_SELECTOR) !== null
	)
}

/**
 * One step along the sequence, or null at either end. Next from a briefing's last slide lands on
 * the first slide of the next briefing; previous from slide one lands on the last slide of the
 * previous one. `counts` is the page count of every briefing.
 */
export function stepStory(
	counts: readonly number[],
	from: StoryPosition,
	delta: 1 | -1,
): StoryPosition | null {
	const slides = counts[from.index] ?? 1
	const slide = Math.min(Math.max(from.slide, 0), slides - 1)
	if (delta === 1) {
		if (slide < slides - 1) return { index: from.index, slide: slide + 1 }
		return from.index < counts.length - 1 ? { index: from.index + 1, slide: 0 } : null
	}
	if (slide > 0) return { index: from.index, slide: slide - 1 }
	if (from.index <= 0) return null
	const before = from.index - 1
	return { index: before, slide: Math.max((counts[before] ?? 1) - 1, 0) }
}

/** Jumping to a briefing (a click on its segment) opens it on its first slide. */
export function jumpToBriefing(counts: readonly number[], index: number): StoryPosition {
	return { index: Math.min(Math.max(index, 0), Math.max(counts.length - 1, 0)), slide: 0 }
}

/**
 * How full each top segment is, 0 to 1: briefings before the open one are full, the open one fills
 * as its slides advance (slide 3 of 6 is half), later ones are empty.
 */
export function storyFill(counts: readonly number[], at: StoryPosition): number[] {
	return counts.map((count, position) => {
		if (position < at.index) return 1
		if (position > at.index) return 0
		return Math.min(Math.max(at.slide + 1, 0), count) / count
	})
}
