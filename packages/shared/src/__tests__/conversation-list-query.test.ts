import { describe, expect, it } from 'vitest'
import { conversationListQuerySchema } from '../schemas/conversations'
import { booleanQueryParam } from '../schemas/primitives'

describe('booleanQueryParam', () => {
	it.each([
		['true', true],
		['TRUE', true],
		['1', true],
		['false', false],
		['False', false],
		['0', false],
		['', false],
	])('reads %j as %s', (raw, expected) => {
		expect(booleanQueryParam.parse(raw)).toBe(expected)
	})

	it('rejects a value it cannot read instead of guessing', () => {
		expect(booleanQueryParam.safeParse('maybe').success).toBe(false)
	})
})

describe('conversationListQuerySchema', () => {
	it('treats archived=false as false (z.coerce.boolean() made it true)', () => {
		expect(conversationListQuerySchema.parse({ archived: 'false' }).archived).toBe(false)
	})

	it('still defaults archived to false when omitted', () => {
		expect(conversationListQuerySchema.parse({}).archived).toBe(false)
	})

	it('reads pinned and unread_only the same way', () => {
		const parsed = conversationListQuerySchema.parse({ pinned: 'false', unread_only: 'true' })
		expect(parsed.pinned).toBe(false)
		expect(parsed.unread_only).toBe(true)
	})
})
