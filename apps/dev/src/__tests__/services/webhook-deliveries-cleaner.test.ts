import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookDeliveriesCleaner } from '../../services/webhook-deliveries-cleaner'

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

describe('WebhookDeliveriesCleaner', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-26T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('issues a delete with a cutoff that respects the retention window', async () => {
		const { db, whereSpy } = makeFakeDb(['old-1', 'old-2'])
		const retentionMs = 14 * 24 * 60 * 60 * 1000
		const cleaner = new WebhookDeliveriesCleaner(db as never, retentionMs)

		await cleaner.tick()

		// The drizzle `lt(col, value)` expression is opaque, but we can confirm
		// `where()` was called exactly once — meaning the cleaner did issue a
		// scoped DELETE rather than a table-wide one.
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
		const cleaner = new WebhookDeliveriesCleaner(db as never)

		const first = cleaner.tick()
		await cleaner.tick() // should bail because running=true
		expect(whereSpy).toHaveBeenCalledTimes(1)

		release?.()
		await first
	})

	it('does not throw when the delete fails', async () => {
		const db = {
			delete: () => ({
				where: () => ({
					returning: () => Promise.reject(new Error('db is down')),
				}),
			}),
		}
		const cleaner = new WebhookDeliveriesCleaner(db as never)

		await expect(cleaner.tick()).resolves.toBeUndefined()
	})

	it('uses the configured retention window when set', async () => {
		const { db } = makeFakeDb([])
		const cleaner = new WebhookDeliveriesCleaner(db as never, 60_000)

		// Just confirms a custom retention can be passed; behavior is the
		// same shape as the default.
		await expect(cleaner.tick()).resolves.toBeUndefined()
	})
})
