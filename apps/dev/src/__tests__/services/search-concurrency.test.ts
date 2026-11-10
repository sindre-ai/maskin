import { SEARCH_MAX_CONCURRENT_SOURCES, settleWithLimit } from '../../services/search'

describe('settleWithLimit', () => {
	it('never runs more than the limit at once and runs every item', async () => {
		let running = 0
		let peak = 0
		const items = Array.from({ length: 10 }, (_, i) => i)
		const results = await settleWithLimit(items, 3, async (n) => {
			running += 1
			peak = Math.max(peak, running)
			await new Promise((r) => setTimeout(r, 2))
			running -= 1
			return n
		})
		expect(peak).toBe(3)
		expect(results).toHaveLength(10)
	})

	it('keeps the order of the items and reports a failure without stopping the rest', async () => {
		const results = await settleWithLimit([1, 2, 3, 4], 2, async (n) => {
			if (n === 2) throw new Error('boom')
			return n * 10
		})
		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled'])
		expect(results[0]).toEqual({ status: 'fulfilled', value: 10 })
		expect(results[3]).toEqual({ status: 'fulfilled', value: 40 })
		expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
	})

	it('handles an empty list and a limit above the item count', async () => {
		expect(await settleWithLimit([], SEARCH_MAX_CONCURRENT_SOURCES, async () => 1)).toEqual([])
		const two = await settleWithLimit([1, 2], 10, async (n) => n)
		expect(two.map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual([1, 2])
	})
})
