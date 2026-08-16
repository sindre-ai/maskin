import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrphanThreadDetector } from '../../services/orphan-thread-detector'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

function makeIdleDb() {
	return {
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: () => Promise.resolve([]),
				}),
			}),
		}),
	}
}

describe('OrphanThreadDetector', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-08-15T10:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('does nothing when there are no candidates', async () => {
		const db = makeIdleDb()
		const detector = new OrphanThreadDetector(db as never)

		await expect(detector.tick()).resolves.toBeUndefined()
	})

	it('does not run overlapping ticks concurrently', async () => {
		let release: (() => void) | null = null
		const selectSpy = vi.fn(() => ({
			from: () => ({
				leftJoin: () => ({
					where: () =>
						new Promise<unknown[]>((resolve) => {
							release = () => resolve([])
						}),
				}),
			}),
		}))
		const db = { select: selectSpy }
		const detector = new OrphanThreadDetector(db as never)

		const first = detector.tick()
		await detector.tick() // should bail immediately

		expect(selectSpy).toHaveBeenCalledTimes(1)

		release?.()
		await first
	})

	it('swallows tick errors so the loop keeps running', async () => {
		const db = {
			select: () => ({
				from: () => ({
					leftJoin: () => ({
						where: () => Promise.reject(new Error('db is down')),
					}),
				}),
			}),
		}
		const detector = new OrphanThreadDetector(db as never)

		await expect(detector.tick()).resolves.toBeUndefined()
	})
})
