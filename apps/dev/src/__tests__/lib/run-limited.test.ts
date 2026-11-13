import { describe, expect, it } from 'vitest'
import { runLimited } from '../../lib/run-limited'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('runLimited', () => {
	it('never runs more than the limit at once and keeps input order', async () => {
		let active = 0
		let peak = 0
		const tasks = Array.from({ length: 10 }, (_, i) => async () => {
			active += 1
			peak = Math.max(peak, active)
			await tick()
			active -= 1
			return i
		})
		const results = await runLimited(3, tasks)
		expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect(peak).toBe(3)
	})

	it('returns an empty array for no tasks', async () => {
		expect(await runLimited(3, [])).toEqual([])
	})

	it('rejects with the first failure and starts no further tasks', async () => {
		let started = 0
		const tasks = Array.from({ length: 8 }, (_, i) => async () => {
			started += 1
			await tick()
			if (i === 0) throw new Error('boom')
			return i
		})
		await expect(runLimited(2, tasks)).rejects.toThrow('boom')
		expect(started).toBeLessThan(8)
	})
})
