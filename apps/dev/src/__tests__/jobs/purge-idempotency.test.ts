import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PurgeIdempotencyJob } from '../../jobs/purge-idempotency'

function makeFakeDb(returnedKeys: string[]) {
	const whereSpy = vi.fn()
	const db = {
		delete: () => ({
			where: (predicate: unknown) => {
				whereSpy(predicate)
				return {
					returning: () => Promise.resolve(returnedKeys.map((key) => ({ key }))),
				}
			},
		}),
	}
	return { db, whereSpy }
}

describe('PurgeIdempotencyJob', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-26T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('issues scoped DELETEs against idempotency_records + linkedin_tool_calls on tick', async () => {
		const { db, whereSpy } = makeFakeDb(['old-1', 'old-2'])
		const job = new PurgeIdempotencyJob(db as never)

		await job.tick()

		// The drizzle `lt(col, cutoff)` expression is opaque, but the count of
		// `.where(...)` calls confirms both purges are scoped, not table-wide,
		// and that Task 7b's linkedin_tool_calls extension fires alongside the
		// original idempotency_records purge.
		expect(whereSpy).toHaveBeenCalledTimes(2)
	})

	it('does not delete twice when ticks overlap', async () => {
		const releases: Array<() => void> = []
		const whereSpy = vi.fn()
		const db = {
			delete: () => ({
				where: (predicate: unknown) => {
					whereSpy(predicate)
					return {
						returning: () =>
							new Promise<{ key: string }[]>((resolve) => {
								releases.push(() => resolve([]))
							}),
					}
				},
			}),
		}
		const job = new PurgeIdempotencyJob(db as never)

		const first = job.tick()
		// The first tick is now mid-flight on the first purge; try to fire a
		// second tick — it should bail because running=true.
		await job.tick()
		// One `.where(...)` call from the in-flight first purge on the first
		// tick — the second table's purge hasn't started yet because the first
		// is still awaiting its `.returning()` promise. Nothing from the second
		// tick.
		expect(whereSpy).toHaveBeenCalledTimes(1)

		// Release both purges the first tick will make (idempotency_records
		// then linkedin_tool_calls). A resolved promise unblocks the awaiter,
		// which then calls the next delete → next promise.
		while (releases.length > 0) {
			const release = releases.shift()
			release?.()
			await Promise.resolve()
		}
		await first
		// After the first tick fully resolves it has performed both purges.
		expect(whereSpy).toHaveBeenCalledTimes(2)
	})

	it('swallows delete failures — a broken tick must not crash the process', async () => {
		const db = {
			delete: () => ({
				where: () => ({
					returning: () => Promise.reject(new Error('db is down')),
				}),
			}),
		}
		const job = new PurgeIdempotencyJob(db as never)

		await expect(job.tick()).resolves.toBeUndefined()
	})

	it('accepts a custom retention window', async () => {
		const { db } = makeFakeDb([])
		const job = new PurgeIdempotencyJob(db as never, 60_000)

		await expect(job.tick()).resolves.toBeUndefined()
	})
})
