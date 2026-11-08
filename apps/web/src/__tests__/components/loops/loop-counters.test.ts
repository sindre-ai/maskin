import { itemsNeedingYou } from '@/components/loops/loop-counters'
import { describe, expect, it } from 'vitest'

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
