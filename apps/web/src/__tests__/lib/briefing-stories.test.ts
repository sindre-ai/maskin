import {
	briefingChatAttachments,
	briefingHeadline,
	isBriefingSeen,
	markBriefingSeen,
	orderBriefingRow,
	pickBriefingChatAgent,
	pickBriefingPages,
	seenBriefingStamps,
	tellMeMoreMessage,
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

describe('pickBriefingChatAgent', () => {
	const fallback = { id: 'default', name: 'Chief of Staff' }

	it('goes to the agent that wrote the page', () => {
		expect(pickBriefingChatAgent({ id: 'a1', name: 'Writer', type: 'agent' }, fallback)).toEqual({
			id: 'a1',
			name: 'Writer',
		})
	})

	it('falls back to the default agent when the author is not a known agent', () => {
		expect(
			pickBriefingChatAgent({ id: null, name: 'Chief of Staff', type: 'agent' }, fallback),
		).toBe(fallback)
		expect(pickBriefingChatAgent({ id: 'h1', name: 'Sam', type: 'human' }, fallback)).toBe(fallback)
	})

	it('is null when there is no agent at all', () => {
		expect(pickBriefingChatAgent({ id: null, name: 'x', type: 'agent' }, undefined)).toBeNull()
	})
})

describe('briefingChatAttachments', () => {
	const card = { id: 'f1', name: 'Briefing.html' }

	it('leads with the page itself', () => {
		expect(briefingChatAttachments(card)).toEqual([
			{ file_id: 'f1', name: 'Briefing.html', mime_type: 'text/html' },
		])
	})

	it("adds the reader's own files after the page and never lists the page twice", () => {
		const result = briefingChatAttachments(card, [
			{ fileId: 'f2', name: 'notes.txt', sizeBytes: 10 },
			{ fileId: 'f1', name: 'Briefing.html' },
		])
		expect(result.map((a) => a.file_id)).toEqual(['f1', 'f2'])
		expect(result[1]).toMatchObject({ mime_type: 'application/octet-stream', size_bytes: 10 })
	})
})

describe('tellMeMoreMessage', () => {
	it('quotes the headline', () => {
		expect(tellMeMoreMessage('Two bets stalled')).toBe(
			'Tell me more about this briefing: "Two bets stalled"',
		)
	})
})
