import { limitConcurrency } from '@/lib/limit-concurrency'
import { describe, expect, it } from 'vitest'

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

describe('limitConcurrency', () => {
	it('runs no more than max calls at once and starts the rest as slots free up', async () => {
		const gates = Array.from({ length: 5 }, deferred)
		let running = 0
		let peak = 0
		const limited = limitConcurrency(2, async (i: number) => {
			running += 1
			peak = Math.max(peak, running)
			await gates[i].promise
			running -= 1
			return i
		})

		const results = Promise.all([0, 1, 2, 3, 4].map((i) => limited(i)))
		await Promise.resolve()
		expect(running).toBe(2)

		for (const gate of gates) {
			gate.resolve()
			await Promise.resolve()
		}
		expect(await results).toEqual([0, 1, 2, 3, 4])
		expect(peak).toBe(2)
	})

	it('frees the slot when a call rejects', async () => {
		const limited = limitConcurrency(1, async (fail: boolean) => {
			if (fail) throw new Error('boom')
			return 'ok'
		})
		await expect(limited(true)).rejects.toThrow('boom')
		await expect(limited(false)).resolves.toBe('ok')
	})
})
