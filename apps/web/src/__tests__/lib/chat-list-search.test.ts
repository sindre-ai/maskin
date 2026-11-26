import { keepListFilter } from '@/lib/chat-list-search'
import { describe, expect, it } from 'vitest'

describe('keepListFilter', () => {
	it('keeps the pill and the legacy filter', () => {
		expect(keepListFilter({ pill: 'unread' })).toEqual({ filter: undefined, pill: 'unread' })
		expect(keepListFilter({ filter: 'archived' })).toEqual({ filter: 'archived', pill: undefined })
	})

	it('leaves the URL clean on the All list', () => {
		expect(keepListFilter({})).toEqual({ filter: undefined, pill: undefined })
	})

	it('does not carry the open thread or message to the next chat', () => {
		const prev = { pill: 'unread', thread: 4, msg: 9 } as Parameters<typeof keepListFilter>[0]
		expect(keepListFilter(prev)).toEqual({ filter: undefined, pill: 'unread' })
	})
})
