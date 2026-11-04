import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const syncAllSpy = vi.hoisted(() => vi.fn())

vi.mock('../../lib/integrations/providers/google-search-console/sync', () => ({
	syncAllGscIntegrations: syncAllSpy,
}))

import { GscSyncScheduler } from '../../services/gsc-sync-scheduler'

const db = {} as Database

describe('GscSyncScheduler.tick', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		syncAllSpy.mockReset()
	})
	afterEach(() => vi.useRealTimers())

	it('runs a sync and allows the next tick once it finishes', async () => {
		syncAllSpy.mockResolvedValue(undefined)
		const scheduler = new GscSyncScheduler(db, 1000)
		await scheduler.tick()
		await scheduler.tick()
		expect(syncAllSpy).toHaveBeenCalledTimes(2)
	})

	it('skips a tick while the previous one is still running', async () => {
		syncAllSpy.mockReturnValue(new Promise(() => {}))
		const scheduler = new GscSyncScheduler(db, 1000)
		void scheduler.tick()
		await scheduler.tick()
		expect(syncAllSpy).toHaveBeenCalledTimes(1)
	})

	it('releases the tick when a sync never settles, so later ticks run', async () => {
		syncAllSpy.mockReturnValueOnce(new Promise(() => {}))
		syncAllSpy.mockResolvedValue(undefined)
		const scheduler = new GscSyncScheduler(db, 1000)

		const hung = scheduler.tick()
		await vi.advanceTimersByTimeAsync(1000)
		await hung

		await scheduler.tick()
		expect(syncAllSpy).toHaveBeenCalledTimes(2)
	})

	it('swallows the rejection of a hung sync that fails after the timeout', async () => {
		let reject: (err: Error) => void = () => {}
		syncAllSpy.mockReturnValueOnce(
			new Promise((_, rej) => {
				reject = rej
			}),
		)
		const scheduler = new GscSyncScheduler(db, 1000)
		const tick = scheduler.tick()
		await vi.advanceTimersByTimeAsync(1000)
		await tick
		reject(new Error('connection closed'))
		await vi.advanceTimersByTimeAsync(0)
	})
})
