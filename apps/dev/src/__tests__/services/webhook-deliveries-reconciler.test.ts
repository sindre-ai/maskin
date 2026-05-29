import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebhookDeliveriesReconciler } from '../../services/webhook-deliveries-reconciler'

type ReleasedRow = {
	id: string
	provider: string
	externalId: string
	workspaceId: string
}

function makeFakeDb(released: ReleasedRow[]) {
	const whereSpy = vi.fn()
	const db = {
		delete: () => ({
			where: (predicate: unknown) => {
				whereSpy(predicate)
				return {
					returning: () => Promise.resolve(released),
				}
			},
		}),
	}
	return { db, whereSpy }
}

describe('WebhookDeliveriesReconciler', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-05-29T00:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('issues a scoped delete on every tick', async () => {
		const { db, whereSpy } = makeFakeDb([])
		const reconciler = new WebhookDeliveriesReconciler(db as never)

		await reconciler.tick()

		// The drizzle `and(isNull(...), lt(...))` expression is opaque; confirming
		// `where()` was called once is enough to know the reconciler scoped the
		// delete instead of clearing the table.
		expect(whereSpy).toHaveBeenCalledTimes(1)
	})

	it('does not run twice when ticks overlap', async () => {
		let release: (() => void) | null = null
		const whereSpy = vi.fn()
		const db = {
			delete: () => ({
				where: (predicate: unknown) => {
					whereSpy(predicate)
					return {
						returning: () =>
							new Promise<ReleasedRow[]>((resolve) => {
								release = () => resolve([])
							}),
					}
				},
			}),
		}
		const reconciler = new WebhookDeliveriesReconciler(db as never)

		const first = reconciler.tick()
		await reconciler.tick() // bail because running=true
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
		const reconciler = new WebhookDeliveriesReconciler(db as never)

		await expect(reconciler.tick()).resolves.toBeUndefined()
	})

	it('logs released orphans with provider summary', async () => {
		const { logger } = await import('../../lib/logger')
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		const released: ReleasedRow[] = [
			{ id: 'r1', provider: 'slack', externalId: 'Ev001', workspaceId: 'ws-1' },
			{ id: 'r2', provider: 'slack', externalId: 'Ev002', workspaceId: 'ws-2' },
		]
		const { db } = makeFakeDb(released)
		const reconciler = new WebhookDeliveriesReconciler(db as never)

		await reconciler.tick()

		expect(warnSpy).toHaveBeenCalledTimes(1)
		const [message, payload] = warnSpy.mock.calls[0] ?? []
		expect(message).toContain('Released orphaned webhook delivery claims')
		expect(payload).toMatchObject({
			count: 2,
			providers: ['slack'],
		})
	})

	it('stays quiet when nothing is released', async () => {
		const { logger } = await import('../../lib/logger')
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		const { db } = makeFakeDb([])
		const reconciler = new WebhookDeliveriesReconciler(db as never)

		await reconciler.tick()

		expect(warnSpy).not.toHaveBeenCalled()
	})

	it('accepts a configured threshold', async () => {
		const { db } = makeFakeDb([])
		const reconciler = new WebhookDeliveriesReconciler(db as never, 60_000)

		await expect(reconciler.tick()).resolves.toBeUndefined()
	})
})
