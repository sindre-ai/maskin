import { buildRecents } from '@/lib/palette/recents'
import { describe, expect, it } from 'vitest'

const objects = [
	{ id: 'o1', title: 'Launch plan', type: 'bet' },
	{ id: 'o2', title: null, type: 'task' },
	{ id: 'o3', title: 'Never opened', type: 'insight' },
]
const chats = [
	{ id: 'c-old', title: 'Old chat', lastMessageAt: '2026-10-01T10:00:00Z' },
	{ id: 'c-new', title: 'New chat', lastMessageAt: '2026-10-25T10:00:00Z' },
	{ id: 'c-archived', title: 'Archived', lastMessageAt: '2026-10-26T10:00:00Z', archived: true },
]
const loops = [
	{ id: 'l-old', name: 'Old loop', updatedAt: '2026-10-01T10:00:00Z' },
	{ id: 'l-new', name: 'New loop', updatedAt: '2026-10-24T10:00:00Z' },
]

describe('buildRecents', () => {
	it('lists opened objects first, then recent chats, then recent loops', () => {
		const items = buildRecents({ objectIds: ['o2', 'o1'], objects, chats, loops, limit: 10 })
		expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
			'object:o2',
			'object:o1',
			'chat:c-new',
			'chat:c-old',
			'loop:l-new',
			'loop:l-old',
		])
		expect(items[0].title).toBe('Untitled')
		expect(items[1].type).toBe('bet')
	})

	it('stops at four by default and never lists an object that was not opened', () => {
		const items = buildRecents({ objectIds: ['o1'], objects, chats, loops })
		expect(items).toHaveLength(4)
		expect(items.some((i) => i.id === 'o3')).toBe(false)
	})

	it('skips opened ids that no longer resolve and archived chats', () => {
		const items = buildRecents({ objectIds: ['gone'], objects, chats, loops: [] })
		expect(items.map((i) => i.id)).toEqual(['c-new', 'c-old'])
	})

	it('is empty when nothing was opened', () => {
		expect(buildRecents({ objectIds: [], objects: [], chats: [], loops: [] })).toEqual([])
	})
})
