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

	it('issues a scoped DELETE against idempotency_records on tick', async () => {
		const { db, whereSpy } = makeFakeDb(['old-1', 'old-2'])
		const job = new PurgeIdempotencyJob(db as never)

		await job.tick()

		// The drizzle `lt(col, cutoff)` expression is opaque, but a single
		// `.where(...)` call confirms the delete is scoped, not table-wide.
		expect(whereSpy).toHaveBeenCalledTimes(1)
	})

	it('does not delete twice when ticks overlap', async () => {
		let release: (() => void) | null = null
		const whereSpy = vi.fn()
		const db = {
			delete: () => ({
				where: (predicate: unknown) => {
					whereSpy(predicate)
					return {
						returning: () =>
							new Promise<{ key: string }[]>((resolve) => {
								release = () => resolve([])
							}),
					}
				},
			}),
		}
		const job = new PurgeIdempotencyJob(db as never)

		const first = job.tick()
		await job.tick() // should bail because running=true
		expect(whereSpy).toHaveBeenCalledTimes(1)

		release?.()
		await first
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
