import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { selfHealMock } = vi.hoisted(() => ({ selfHealMock: vi.fn() }))

vi.mock('../../services/session-reconciler', () => ({
	SessionReconciler: class {
		selfHealTerminalWithoutEvents = selfHealMock
	},
}))

import { SessionSelfHealJob } from '../../services/session-self-heal-job'

describe('SessionSelfHealJob', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		selfHealMock.mockReset()
		selfHealMock.mockResolvedValue({ staleConsidered: 0, backFilled: [] })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('runs the self-heal pass on every interval tick after start()', async () => {
		const job = new SessionSelfHealJob({} as never, 1_000)
		job.start()
		await vi.advanceTimersByTimeAsync(3_000)
		job.stop()
		expect(selfHealMock).toHaveBeenCalledTimes(3)
	})

	it('start() is idempotent and stop() halts ticking', async () => {
		const job = new SessionSelfHealJob({} as never, 1_000)
		job.start()
		job.start()
		await vi.advanceTimersByTimeAsync(1_000)
		expect(selfHealMock).toHaveBeenCalledTimes(1)
		job.stop()
		await vi.advanceTimersByTimeAsync(5_000)
		expect(selfHealMock).toHaveBeenCalledTimes(1)
	})

	it('does not overlap ticks while a pass is in flight', async () => {
		let release: (() => void) | undefined
		selfHealMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve({ staleConsidered: 0, backFilled: [] })
				}),
		)
		const job = new SessionSelfHealJob({} as never)
		const first = job.tick()
		await job.tick()
		expect(selfHealMock).toHaveBeenCalledTimes(1)
		release?.()
		await first
		const third = job.tick()
		release?.()
		await third
		expect(selfHealMock).toHaveBeenCalledTimes(2)
	})

	it('swallows a failing pass and keeps ticking', async () => {
		selfHealMock.mockRejectedValueOnce(new Error('db down'))
		const job = new SessionSelfHealJob({} as never)
		await expect(job.tick()).resolves.toBeUndefined()
		await job.tick()
		expect(selfHealMock).toHaveBeenCalledTimes(2)
	})
})
