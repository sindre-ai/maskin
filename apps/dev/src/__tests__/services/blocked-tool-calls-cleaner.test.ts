import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockedToolCallsCleaner } from '../../services/blocked-tool-calls-cleaner'

function makeFakeDb(returnedIds: string[]) {
	const whereSpy = vi.fn()
	const db = {
		delete: () => ({
			where: (predicate: unknown) => {
				whereSpy(predicate)
				return {
					returning: () => Promise.resolve(returnedIds.map((id) => ({ id }))),
				}
			},
		}),
	}
	return { db, whereSpy }
}

describe('BlockedToolCallsCleaner', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-10-18T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('issues one scoped delete per tick', async () => {
		const { db, whereSpy } = makeFakeDb(['old-1', 'old-2'])
		const cleaner = new BlockedToolCallsCleaner(db as never)

		await cleaner.tick()

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
							new Promise<{ id: string }[]>((resolve) => {
								release = () => resolve([])
							}),
					}
				},
			}),
		}
		const cleaner = new BlockedToolCallsCleaner(db as never)

		const first = cleaner.tick()
		await cleaner.tick()
		expect(whereSpy).toHaveBeenCalledTimes(1)

		release?.()
		await first
	})

	it('does not throw when the delete fails', async () => {
		const db = {
			delete: () => ({
				where: () => ({ returning: () => Promise.reject(new Error('db down')) }),
			}),
		}
		const cleaner = new BlockedToolCallsCleaner(db as never)

		await expect(cleaner.tick()).resolves.toBeUndefined()
	})
})
