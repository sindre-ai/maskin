import {
	type DraftHistory,
	decideLinkedPlacements,
	editTimes,
	idsLinkedMoreThanOnce,
} from '@/lib/linked-card-holders'
import { describe, expect, it } from 'vitest'

const DRAFT = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const PAGE = '4aee24db-5d54-476a-8399-9586516e7de1'

const msg = (id: number, minute: number, ...linkedIds: string[]) => ({
	id,
	createdAt: `2026-10-26T10:0${minute}:00.000Z`,
	linkedIds,
})
const at = (minute: number) => `2026-10-26T10:0${minute}:30.000Z`

const isDraft = (id: string) => id === DRAFT
const ready = (...editedAt: string[]): DraftHistory => ({ state: 'ready', editedAt })

describe('decideLinkedPlacements', () => {
	it('gives the first link the card and draws nothing special', () => {
		const placements = decideLinkedPlacements([msg(1, 1, DRAFT, PAGE)], isDraft, () => ready())
		expect(placements.get(1)?.skipIds.size).toBe(0)
		expect(placements.get(1)?.updatedIds.size).toBe(0)
	})

	it('moves a revised draft card to the newest message and tags it Updated', () => {
		const placements = decideLinkedPlacements([msg(1, 1, DRAFT), msg(2, 2, DRAFT)], isDraft, () =>
			ready(at(1)),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(1)?.updatedIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.updatedIds.has(DRAFT)).toBe(true)
	})

	it('leaves an unchanged re-link as a chip under the first card', () => {
		const placements = decideLinkedPlacements([msg(1, 1, DRAFT), msg(2, 2, DRAFT)], isDraft, () =>
			ready(),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.updatedIds.has(DRAFT)).toBe(false)
	})

	it('ignores an edit made before the message that holds the card', () => {
		const placements = decideLinkedPlacements([msg(1, 2, DRAFT), msg(2, 3, DRAFT)], isDraft, () =>
			ready(at(1)),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(true)
	})

	it('measures a revision against the message that holds the card now', () => {
		// edited once, between messages 1 and 2: message 3 links it unchanged since message 2
		const placements = decideLinkedPlacements(
			[msg(1, 1, DRAFT), msg(2, 2, DRAFT), msg(3, 3, DRAFT)],
			isDraft,
			() => ready(at(1)),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.updatedIds.has(DRAFT)).toBe(true)
		expect(placements.get(3)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(3)?.updatedIds.has(DRAFT)).toBe(false)
	})

	it('moves the card again when the draft is edited again', () => {
		const placements = decideLinkedPlacements(
			[msg(1, 1, DRAFT), msg(2, 2, DRAFT), msg(3, 3, DRAFT)],
			isDraft,
			() => ready(at(1), at(2)),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.updatedIds.has(DRAFT)).toBe(false)
		expect(placements.get(3)?.updatedIds.has(DRAFT)).toBe(true)
	})

	it('does not count an approval or a status move as a revision', () => {
		// The edit times come from the history: an approved event and a plain status move add none.
		const editedAt = editTimes([
			{ action: 'approved', createdAt: at(1), data: { content_hash: 'x' } },
			{ action: 'status_changed', createdAt: at(1), data: { changes: [{ field: 'status' }] } },
		])
		const placements = decideLinkedPlacements(
			[msg(1, 1, DRAFT), msg(2, 2, DRAFT)],
			isDraft,
			() => ({
				state: 'ready',
				editedAt,
			}),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.updatedIds.size).toBe(0)
	})

	it('keeps the first card while the history is loading', () => {
		const placements = decideLinkedPlacements(
			[msg(1, 1, DRAFT), msg(2, 2, DRAFT)],
			isDraft,
			() => ({
				state: 'loading',
			}),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.updatedIds.size).toBe(0)
	})

	it('gives the newest message the card, untagged, when the history failed', () => {
		const placements = decideLinkedPlacements(
			[msg(1, 1, DRAFT), msg(2, 2, DRAFT)],
			isDraft,
			() => ({
				state: 'failed',
			}),
		)
		expect(placements.get(1)?.skipIds.has(DRAFT)).toBe(true)
		expect(placements.get(2)?.skipIds.has(DRAFT)).toBe(false)
		expect(placements.get(2)?.updatedIds.size).toBe(0)
	})

	it('never moves the card of an object that is not a draft', () => {
		const placements = decideLinkedPlacements([msg(1, 1, PAGE), msg(2, 2, PAGE)], isDraft, () =>
			ready(at(1)),
		)
		expect(placements.get(1)?.skipIds.has(PAGE)).toBe(false)
		expect(placements.get(2)?.skipIds.has(PAGE)).toBe(true)
		expect(placements.get(2)?.updatedIds.size).toBe(0)
	})

	it('decides each id on its own', () => {
		const placements = decideLinkedPlacements(
			[msg(1, 1, DRAFT, PAGE), msg(2, 2, DRAFT, PAGE)],
			isDraft,
			() => ready(at(1)),
		)
		expect([...(placements.get(1)?.skipIds ?? [])]).toEqual([DRAFT])
		expect([...(placements.get(2)?.skipIds ?? [])]).toEqual([PAGE])
		expect([...(placements.get(2)?.updatedIds ?? [])]).toEqual([DRAFT])
	})

	it('asks about draft status and history only for ids linked again', () => {
		const asked: string[] = []
		decideLinkedPlacements(
			[msg(1, 1, DRAFT, PAGE), msg(2, 2, DRAFT)],
			(id) => {
				asked.push(id)
				return isDraft(id)
			},
			() => ready(),
		)
		expect(asked).toEqual([DRAFT])
	})
})

describe('idsLinkedMoreThanOnce', () => {
	it('lists only the ids two or more messages link', () => {
		expect(idsLinkedMoreThanOnce([msg(1, 1, DRAFT, PAGE), msg(2, 2, DRAFT)])).toEqual([DRAFT])
		expect(idsLinkedMoreThanOnce([msg(1, 1, DRAFT), msg(2, 2, PAGE)])).toEqual([])
	})
})

describe('editTimes', () => {
	it('lists edits to the title, text or metadata', () => {
		expect(
			editTimes([
				{ action: 'updated', createdAt: at(1), data: { changes: [{ field: 'content' }] } },
				{ action: 'updated', createdAt: at(2), data: { changes: [{ field: 'title' }] } },
				{ action: 'status_changed', createdAt: at(3), data: { changes: [{ field: 'metadata' }] } },
			]),
		).toEqual([at(1), at(2), at(3)])
	})

	it('skips approvals, status moves, driver changes, comments and rows it cannot read', () => {
		expect(
			editTimes([
				{ action: 'approved', createdAt: at(1), data: null },
				{ action: 'status_changed', createdAt: at(1), data: { changes: [{ field: 'status' }] } },
				{ action: 'updated', createdAt: at(1), data: { changes: [{ field: 'driver' }] } },
				{ action: 'commented', createdAt: at(1), data: { content: 'hi' } },
				{ action: 'updated', createdAt: null, data: { changes: [{ field: 'content' }] } },
				{ action: 'updated', createdAt: at(1), data: null },
			]),
		).toEqual([])
	})
})
