import { describe, expect, it } from 'vitest'
import {
	MAX_TEXT_ANCHOR_QUOTE,
	createFileCommentSchema,
	fileCommentSchema,
} from '../schemas/file-comments'

const base = { body: 'a comment', positionDoc: { x: 0.2, y: 0.4 } }
const anchor = { quote: 'the quoted passage', prefix: 'before ', suffix: ' after' }

describe('createFileCommentSchema text anchor', () => {
	it('accepts a comment without a text anchor', () => {
		expect(createFileCommentSchema.safeParse(base).success).toBe(true)
	})

	it('accepts a comment with a text anchor', () => {
		const parsed = createFileCommentSchema.parse({ ...base, textAnchor: anchor })
		expect(parsed.textAnchor).toEqual(anchor)
	})

	it('accepts a null text anchor', () => {
		expect(createFileCommentSchema.safeParse({ ...base, textAnchor: null }).success).toBe(true)
	})

	it('accepts a quote of exactly 500 characters', () => {
		const textAnchor = { ...anchor, quote: 'q'.repeat(MAX_TEXT_ANCHOR_QUOTE) }
		expect(createFileCommentSchema.safeParse({ ...base, textAnchor }).success).toBe(true)
	})

	it('rejects a quote longer than 500 characters', () => {
		const textAnchor = { ...anchor, quote: 'q'.repeat(MAX_TEXT_ANCHOR_QUOTE + 1) }
		expect(createFileCommentSchema.safeParse({ ...base, textAnchor }).success).toBe(false)
	})

	it('rejects an empty quote', () => {
		const textAnchor = { ...anchor, quote: '' }
		expect(createFileCommentSchema.safeParse({ ...base, textAnchor }).success).toBe(false)
	})

	it('keeps positionDoc required when a text anchor is present', () => {
		const withoutPosition = { body: 'a comment', textAnchor: anchor }
		expect(createFileCommentSchema.safeParse(withoutPosition).success).toBe(false)
	})
})

describe('fileCommentSchema text anchor', () => {
	const row = {
		id: '11111111-1111-4111-8111-111111111111',
		fileId: '22222222-2222-4222-8222-222222222222',
		page: null,
		positionDoc: { x: 0.2, y: 0.4 },
		selector: null,
		authorId: '33333333-3333-4333-8333-333333333333',
		body: 'a comment',
		parentId: null,
		roundId: null,
		resolvedAt: null,
		resolvedBy: null,
		createdAt: '2026-10-19T00:00:00.000Z',
		updatedAt: '2026-10-19T00:00:00.000Z',
	}

	it('parses a comment with and without a text anchor', () => {
		expect(fileCommentSchema.safeParse({ ...row, textAnchor: anchor }).success).toBe(true)
		expect(fileCommentSchema.safeParse({ ...row, textAnchor: null }).success).toBe(true)
		expect(fileCommentSchema.safeParse(row).success).toBe(true)
	})
})
