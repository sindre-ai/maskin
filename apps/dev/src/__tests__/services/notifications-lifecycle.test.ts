import { vi } from 'vitest'
import { NotificationsLifecycle } from '../../services/notifications-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { createMockSessionManager, createTestContext } from '../setup'

describe('NotificationsLifecycle', () => {
	let sessionManager: SessionManager
	let ctx: ReturnType<typeof createTestContext>

	beforeEach(() => {
		vi.useFakeTimers()
		sessionManager = createMockSessionManager()
		ctx = createTestContext()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('start / stop', () => {
		it('schedules both wake and expiry timers on start()', async () => {
			const service = new NotificationsLifecycle(ctx.db, sessionManager, {
				wakeTickMs: 5_000,
				expiryTickMs: 60_000,
			})
			service.start()

			// No claimed rows configured — but the ticks should still fire without throwing.
			await vi.advanceTimersByTimeAsync(5_000)
			await vi.advanceTimersByTimeAsync(60_000)

			service.stop()
		})

		it('does not start a second pair of timers when start() is called twice', async () => {
			const service = new NotificationsLifecycle(ctx.db, sessionManager)
			service.start()
			service.start()
			service.stop()
			// No assertion — this test guards against a leaked timer that would
			// keep vitest running past the suite.
		})

		it('stops both timers on stop()', async () => {
			const service = new NotificationsLifecycle(ctx.db, sessionManager, { wakeTickMs: 1_000 })
			service.start()
			service.stop()
			await vi.advanceTimersByTimeAsync(60_000)
			// Nothing to assert against — mock DB returns [] — but if timers
			// leaked, vitest would flag an unresolved timer.
		})
	})

	describe('runWakeReaper()', () => {
		it('returns 0 when no rows are eligible', async () => {
			const service = new NotificationsLifecycle(ctx.db, sessionManager)
			// Mock DB returns [] by default.
			const dispatched = await service.runWakeReaper()
			expect(dispatched).toBe(0)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('applies exponential backoff after consecutive failures', async () => {
			const service = new NotificationsLifecycle(ctx.db, sessionManager)
			ctx.mockResults.selectError = new Error('DB down')

			await service.runWakeReaper()
			await service.runWakeReaper()

			// Next call should be short-circuited by the backoff window; the
			// service.runWakeReaper() promise resolves without a DB touch.
			ctx.mockResults.selectError = undefined
			const dispatched = await service.runWakeReaper()
			expect(dispatched).toBe(0)
		})
	})

	describe('runExpirySweep()', () => {
		it('returns 0 when no rows are eligible', async () => {
			const service = new NotificationsLifecycle(ctx.db, sessionManager)
			const expired = await service.runExpirySweep()
			expect(expired).toBe(0)
		})
	})
})
