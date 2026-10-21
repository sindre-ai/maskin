import {
	briefingHeadline,
	isBriefingSeen,
	markBriefingSeen,
	orderBriefingRow,
	pickBriefingPages,
	seenBriefingStamps,
} from '@/lib/briefing-stories'
import { beforeEach, describe, expect, it } from 'vitest'

const file = (id: string, updatedAt: string, mimeType = 'text/html') => ({
	id,
	name: `${id}.html`,
	mimeType,
	updatedAt,
})

describe('briefingHeadline', () => {
	it('prefers the <title>', () => {
		const html =
			'<html><head><title>Two bets stalled</title></head><body><h1>Other</h1></body></html>'
		expect(briefingHeadline(html, 'Briefing.html')).toBe('Two bets stalled')
	})

	it('falls back to the first <h1>, decoding entities and collapsing whitespace', () => {
		const html = '<body><h1>  Pipeline &amp;\n  leads </h1><h1>Second</h1></body>'
		expect(briefingHeadline(html, 'Briefing.html')).toBe('Pipeline & leads')
	})

	it('falls back to the file name without its extension', () => {
		expect(briefingHeadline('<p>no heading</p>', 'Briefing_2026-10-21.html')).toBe(
			'Briefing 2026 10 21',
		)
		expect(briefingHeadline(undefined, 'Weekly-review.html')).toBe('Weekly review')
	})
})

describe('pickBriefingPages', () => {
	it('keeps only HTML, drops duplicates, and sorts newest first', () => {
		const picked = pickBriefingPages([
			file('old', '2026-10-01T05:00:00Z'),
			file('pdf', '2026-10-21T05:00:00Z', 'application/pdf'),
			file('new', '2026-10-20T05:00:00Z'),
			file('new', '2026-10-20T05:00:00Z'),
		])
		expect(picked.map((f) => f.id)).toEqual(['new', 'old'])
	})

	it('caps the row at 12 cards', () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			file(`f${i}`, new Date(Date.UTC(2026, 9, 1, i)).toISOString()),
		)
		expect(pickBriefingPages(many)).toHaveLength(12)
	})
})

describe('seen briefings', () => {
	beforeEach(() => localStorage.clear())

	const card = { id: 'a', updatedAt: '2026-10-21T05:00:00Z' }

	it('is unseen until opened, and stays seen', () => {
		expect(isBriefingSeen(card)).toBe(false)
		markBriefingSeen(card)
		expect(isBriefingSeen(card)).toBe(true)
	})

	it('is unseen again once the page is edited', () => {
		markBriefingSeen(card)
		expect(isBriefingSeen({ ...card, updatedAt: '2026-10-21T09:00:00Z' })).toBe(false)
	})

	it('survives corrupt storage by treating everything as unseen', () => {
		localStorage.setItem('maskin-seen-briefings', '{not json')
		expect(seenBriefingStamps().size).toBe(0)
		expect(() => markBriefingSeen(card)).not.toThrow()
	})

	it('moves seen cards after unseen ones, keeping each group in order', () => {
		const a = { id: 'a', updatedAt: '2026-10-21T05:00:00Z' }
		const b = { id: 'b', updatedAt: '2026-10-20T05:00:00Z' }
		const c = { id: 'c', updatedAt: '2026-10-19T05:00:00Z' }
		markBriefingSeen(a)
		expect(orderBriefingRow([a, b, c], seenBriefingStamps()).map((x) => x.id)).toEqual([
			'b',
			'c',
			'a',
		])
	})
})
