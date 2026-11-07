import { itemsNeedingYou, loopCounters } from '@/components/loops/loop-counters'
import { describe, expect, it } from 'vitest'

describe('loopCounters', () => {
	it('counts items by the group their status name belongs to', () => {
		const items = [
			{ status: 'todo' },
			{ status: 'in_progress' },
			{ status: 'done' },
			{ status: 'done' },
		]
		expect(loopCounters(items).map((c) => [c.key, c.count])).toEqual([
			['proposed', 1],
			['in_progress', 1],
			['done', 2],
		])
	})

	it('hides a counter when no known status maps to it', () => {
		const counters = loopCounters([{ status: 'in_progress' }], { task: ['in_progress'] })
		expect(counters.map((c) => c.key)).toEqual(['in_progress'])
	})

	it('shows a counter the workspace defines even when no item is in it yet', () => {
		const counters = loopCounters([{ status: 'todo' }], { task: ['todo', 'in_progress', 'done'] })
		expect(counters.map((c) => [c.key, c.count])).toEqual([
			['proposed', 1],
			['in_progress', 0],
			['done', 0],
		])
	})
})

describe('itemsNeedingYou', () => {
	const items = [
		{ id: 'a', title: 'A' },
		{ id: 'b', title: 'B' },
	]
	const ask = (over: Record<string, unknown>) => ({
		objectId: 'a',
		status: 'pending',
		targetActorId: 'me',
		title: 'Approve?',
		...over,
	})

	it('lists the flow items with a pending ask for the viewer, once each', () => {
		const rows = itemsNeedingYou(items, [ask({}), ask({})], 'me')
		expect(rows.map((r) => r.item.id)).toEqual(['a'])
	})

	it('ignores resolved asks, asks for someone else and items outside the flow', () => {
		const rows = itemsNeedingYou(
			items,
			[
				ask({ status: 'resolved' }),
				ask({ targetActorId: 'other' }),
				ask({ objectId: 'elsewhere' }),
			],
			'me',
		)
		expect(rows).toEqual([])
	})
})
