import { decideLinkedDraws, editedSince } from '@/lib/linked-card-holders'
import { describe, expect, it } from 'vitest'

const DRAFT = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const PAGE = '4aee24db-5d54-476a-8399-9586516e7de1'

const msg = (id: number, minute: number, ...linkedIds: string[]) => ({
	id,
	createdAt: `2026-10-26T10:0${minute}:00.000Z`,
	linkedIds,
})
const at = (minute: number) => `2026-10-26T10:0${minute}:30.000Z`

describe('decideLinkedDraws', () => {
	const drafts = (id: string) => id === DRAFT

	it('gives the first link the card', () => {
		const draws = decideLinkedDraws([msg(1, 1, DRAFT, PAGE)], drafts, () => false)
		expect(draws.get(1)?.get(DRAFT)).toBe('card')
		expect(draws.get(1)?.get(PAGE)).toBe('card')
	})

	it('moves a revised draft card to the newest message and tags it Updated', () => {
		// edited at 10:01:30, between the two messages
		const draws = decideLinkedDraws([msg(1, 1, DRAFT), msg(2, 2, DRAFT)], drafts, (_id, since) =>
			editedSince(
				[{ action: 'updated', createdAt: at(1), data: { changes: [{ field: 'content' }] } }],
				since,
			),
		)
		expect(draws.get(1)?.get(DRAFT)).toBe('row')
		expect(draws.get(2)?.get(DRAFT)).toBe('updated')
	})

	it('leaves an unchanged re-link as a row under the first card', () => {
		const draws = decideLinkedDraws([msg(1, 1, DRAFT), msg(2, 2, DRAFT)], drafts, () => false)
		expect(draws.get(1)?.get(DRAFT)).toBe('card')
		expect(draws.get(2)?.get(DRAFT)).toBe('row')
	})

	it('does not count an approval or a status move as a revision', () => {
		const events = [
			{ action: 'approved', createdAt: at(1), data: { content_hash: 'x' } },
			{ action: 'status_changed', createdAt: at(1), data: { changes: [{ field: 'status' }] } },
		]
		const draws = decideLinkedDraws([msg(1, 1, DRAFT), msg(2, 2, DRAFT)], drafts, (_id, since) =>
			editedSince(events, since),
		)
		expect(draws.get(1)?.get(DRAFT)).toBe('card')
		expect(draws.get(2)?.get(DRAFT)).toBe('row')
	})

	it('measures a revision against the message that holds the card now', () => {
		// edited once, between messages 1 and 2: message 3 links it unchanged since message 2
		const events = [
			{ action: 'updated', createdAt: at(1), data: { changes: [{ field: 'title' }] } },
		]
		const draws = decideLinkedDraws(
			[msg(1, 1, DRAFT), msg(2, 2, DRAFT), msg(3, 3, DRAFT)],
			drafts,
			(_id, since) => editedSince(events, since),
		)
		expect(draws.get(1)?.get(DRAFT)).toBe('row')
		expect(draws.get(2)?.get(DRAFT)).toBe('updated')
		expect(draws.get(3)?.get(DRAFT)).toBe('row')
	})

	it('keeps first-link-wins for a page even when it changed', () => {
		const draws = decideLinkedDraws([msg(1, 1, PAGE), msg(2, 2, PAGE)], drafts, () => true)
		expect(draws.get(1)?.get(PAGE)).toBe('card')
		expect(draws.get(2)?.get(PAGE)).toBe('row')
	})

	it('asks about an id only when it is linked again', () => {
		const asked: string[] = []
		const isDraft = (id: string) => {
			asked.push(id)
			return false
		}
		decideLinkedDraws([msg(1, 1, DRAFT, PAGE), msg(2, 2, PAGE)], isDraft, () => false)
		expect(asked).toEqual([PAGE])
	})
})

describe('editedSince', () => {
	const edit = (field: string, minute: number, action = 'updated') => ({
		action,
		createdAt: at(minute),
		data: { changes: [{ field }] },
	})

	it('counts a title, text or metadata edit after the time', () => {
		for (const field of ['title', 'content', 'metadata']) {
			expect(editedSince([edit(field, 2)], '2026-10-26T10:01:00.000Z')).toBe(true)
		}
	})

	it('counts a text edit made together with a status move', () => {
		const event = {
			...edit('status', 2, 'status_changed'),
			data: { changes: [{ field: 'status' }, { field: 'content' }] },
		}
		expect(editedSince([event], '2026-10-26T10:01:00.000Z')).toBe(true)
	})

	it('ignores edits before the time, status moves, driver changes and events without changes', () => {
		const since = '2026-10-26T10:03:00.000Z'
		expect(editedSince([edit('content', 1)], since)).toBe(false)
		expect(editedSince([edit('status', 5, 'status_changed')], since)).toBe(false)
		expect(editedSince([edit('driver', 5)], since)).toBe(false)
		expect(editedSince([{ action: 'updated', createdAt: at(5), data: null }], since)).toBe(false)
	})
})
