import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { vi } from 'vitest'
import {
	CIRCUIT_BREAKER_THRESHOLD,
	TriggerRunner,
	calculateBackoffUntil,
	evaluateCondition,
	evaluateConditions,
	getObjectFromData,
} from '../../services/trigger-runner'
import { buildTrigger } from '../factories'
import { createMockSessionManager, createTestContext } from '../setup'

describe('TriggerRunner', () => {
	let runner: TriggerRunner
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: Record<string, unknown>

	beforeEach(() => {
		vi.useFakeTimers()
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		runner = new TriggerRunner(ctx.db, bridge, sessionManager)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
		})
	})

	afterEach(async () => {
		await runner.stop()
		vi.useRealTimers()
	})

	describe('start()', () => {
		it('registers event listener on bridge', async () => {
			mockResults.select = [] // no cron or reminder triggers
			await runner.start()
			expect(bridge.listenerCount('event')).toBe(2)
		})
	})

	describe('stop()', () => {
		it('clears all intervals and timeouts', async () => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
			mockResults.selectQueue = [
				// cron triggers
				[buildTrigger({ type: 'cron', config: { expression: '*/5 * * * *' } })],
				// reminder triggers
				[],
			]
			await runner.start()
			await runner.stop()

			// Advancing time should not create sessions
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockClear()
			vi.advanceTimersByTime(600_000)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('stops croner jobs so they no longer fire', async () => {
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '*/1 * * * *' },
			})
			mockResults.selectQueue = [
				[trigger], // cron triggers
				[], // reminder triggers
			]
			mockResults.insert = []
			await runner.start()

			// Fire once to confirm it works
			await vi.advanceTimersByTimeAsync(60 * 1000)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)

			// Stop and verify no further fires
			await runner.stop()
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockClear()
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('handleEvent()', () => {
		const baseEvent: PgEvent = {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-1',
		}

		beforeEach(async () => {
			mockResults.selectQueue = [
				[], // cron triggers (empty for start)
				[], // reminder triggers (empty for start)
			]
			await runner.start()
		})

		it('fires matching trigger and creates session', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'task', action: 'created' },
			})
			mockResults.select = [trigger]
			mockResults.insert = [] // event insert

			bridge.emit('event', baseEvent)
			await vi.advanceTimersByTimeAsync(0) // flush microtasks

			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		it('does not fire when entity_type mismatches', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'insight', action: 'created' },
			})
			mockResults.select = [trigger]

			bridge.emit('event', baseEvent)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('does not fire when action mismatches', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'task', action: 'updated' },
			})
			mockResults.select = [trigger]

			bridge.emit('event', baseEvent)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('does not fire when filter mismatches', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'task', action: 'created', filter: { priority: 'high' } },
			})
			mockResults.selectQueue = [
				[trigger], // matching triggers
				[{ data: { priority: 'low' } }], // fetchEventData
			]

			bridge.emit('event', baseEvent)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('fires on matching status transition', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: {
					entity_type: 'task',
					action: 'updated',
					from_status: 'todo',
					to_status: 'in_progress',
				},
			})
			mockResults.selectQueue = [
				[trigger], // matching triggers
				[{ data: { previous: { status: 'todo' }, updated: { status: 'in_progress' } } }], // fetchEventData
			]
			mockResults.insert = []

			const event: PgEvent = {
				...baseEvent,
				action: 'updated',
			}
			bridge.emit('event', event)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		it('fetches event data from DB when trigger has filter conditions', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'task', action: 'created', filter: { priority: 'high' } },
			})
			mockResults.selectQueue = [
				[trigger], // matching triggers
				[{ data: { priority: 'high' } }], // fetchEventData from DB
			]
			mockResults.insert = []

			bridge.emit('event', baseEvent)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		it('skips trigger when event data cannot be fetched from DB', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'task', action: 'created', filter: { priority: 'high' } },
			})
			mockResults.selectQueue = [
				[trigger], // matching triggers
				[], // fetchEventData returns no row
			]

			bridge.emit('event', baseEvent)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('cron scheduling', () => {
		it('fires cron trigger at correct interval', async () => {
			vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '*/5 * * * *' },
			})
			mockResults.selectQueue = [
				[trigger], // cron triggers
				[], // reminder triggers
			]
			mockResults.insert = []
			await runner.start()

			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		it('fires daily cron at the correct time', async () => {
			vi.setSystemTime(new Date('2026-01-01T08:59:00Z'))
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '0 9 * * *' },
			})
			mockResults.selectQueue = [[trigger], []]
			mockResults.insert = []
			await runner.start()

			// Should NOT have fired yet (still before 9:00)
			await vi.advanceTimersByTimeAsync(30_000)
			expect(sessionManager.createSession).not.toHaveBeenCalled()

			// Advance to 9:00 AM
			await vi.advanceTimersByTimeAsync(30_000)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		})

		it('fires weekday-only cron on correct days', async () => {
			// 2026-01-01 is a Thursday
			vi.setSystemTime(new Date('2026-01-01T08:00:00Z'))
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '30 8 * * 1-5' },
			})
			mockResults.selectQueue = [[trigger], []]
			mockResults.insert = []
			await runner.start()

			// Advance 30 minutes to 8:30 — Thursday is a weekday, should fire
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		})

		it('handles invalid cron expression gracefully', async () => {
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: 'not-a-cron' },
			})
			mockResults.selectQueue = [[trigger], []]
			await runner.start()

			// Should not throw, should not create a session
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	describe('reminder scheduling', () => {
		it('fires reminder and auto-disables', async () => {
			const scheduledAt = new Date(Date.now() + 10_000).toISOString()
			const trigger = buildTrigger({
				type: 'reminder',
				config: { scheduled_at: scheduledAt },
			})
			mockResults.selectQueue = [
				[], // cron triggers
				[trigger], // reminder triggers
			]
			mockResults.insert = []
			await runner.start()

			await vi.advanceTimersByTimeAsync(10_000)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})
	})

	describe('hot-reload via events', () => {
		it('schedules a new cron trigger when created event arrives', async () => {
			// Start with no triggers
			mockResults.selectQueue = [[], []]
			await runner.start()

			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '*/1 * * * *' },
				enabled: true,
			})

			// Mock DB to return the new trigger when fetched
			mockResults.selectQueue = [[trigger]]
			mockResults.insert = []

			bridge.emit('event', {
				workspace_id: trigger.workspaceId,
				actor_id: trigger.createdBy,
				action: 'created',
				entity_type: 'trigger',
				entity_id: trigger.id,
				event_id: 'evt-1',
			} satisfies PgEvent)

			// Let the async handler run
			await vi.advanceTimersByTimeAsync(0)

			// Advance 60s to hit the cron schedule
			await vi.advanceTimersByTimeAsync(60 * 1000)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		it('stops a cron trigger when updated to disabled', async () => {
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '*/1 * * * *' },
				enabled: true,
			})
			mockResults.selectQueue = [[trigger], []]
			mockResults.insert = []
			await runner.start()

			// Verify it fires
			await vi.advanceTimersByTimeAsync(60 * 1000)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockClear()

			// Now disable via update event
			const disabled = { ...trigger, enabled: false }
			mockResults.selectQueue = [[disabled]]

			bridge.emit('event', {
				workspace_id: trigger.workspaceId,
				actor_id: trigger.createdBy,
				action: 'updated',
				entity_type: 'trigger',
				entity_id: trigger.id,
				event_id: 'evt-2',
			} satisfies PgEvent)

			await vi.advanceTimersByTimeAsync(0)

			// Should not fire again
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})

		it('stops a cron trigger when deleted event arrives', async () => {
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '*/1 * * * *' },
				enabled: true,
			})
			mockResults.selectQueue = [[trigger], []]
			mockResults.insert = []
			await runner.start()

			// Verify it fires
			await vi.advanceTimersByTimeAsync(60 * 1000)
			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockClear()

			bridge.emit('event', {
				workspace_id: trigger.workspaceId,
				actor_id: trigger.createdBy,
				action: 'deleted',
				entity_type: 'trigger',
				entity_id: trigger.id,
				event_id: 'evt-3',
			} satisfies PgEvent)

			await vi.advanceTimersByTimeAsync(0)

			// Should not fire again
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})
})

describe('calculateBackoffUntil()', () => {
	it('calculates exponential backoff: 1min, 2min, 4min, 8min, 16min, 30min cap', () => {
		const now = new Date('2026-01-01T00:00:00Z')

		// 2^1 * 60s = 2min (failure count 1)
		expect(calculateBackoffUntil(1, now).getTime() - now.getTime()).toBe(2 * 60_000)
		// 2^2 * 60s = 4min
		expect(calculateBackoffUntil(2, now).getTime() - now.getTime()).toBe(4 * 60_000)
		// 2^3 * 60s = 8min
		expect(calculateBackoffUntil(3, now).getTime() - now.getTime()).toBe(8 * 60_000)
		// 2^4 * 60s = 16min
		expect(calculateBackoffUntil(4, now).getTime() - now.getTime()).toBe(16 * 60_000)
		// 2^5 * 60s = 32min → capped at 30min
		expect(calculateBackoffUntil(5, now).getTime() - now.getTime()).toBe(30 * 60_000)
		// Higher counts stay capped
		expect(calculateBackoffUntil(10, now).getTime() - now.getTime()).toBe(30 * 60_000)
	})
})

describe('TriggerRunner backoff', () => {
	let runner: TriggerRunner
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: Record<string, unknown>

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		runner = new TriggerRunner(ctx.db, bridge, sessionManager)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-1',
		})
	})

	afterEach(async () => {
		await runner.stop()
		vi.useRealTimers()
	})

	it('skips event trigger firing when in backoff period', async () => {
		const trigger = buildTrigger({
			id: 'trigger-1',
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
		})

		mockResults.selectQueue = [
			[], // cron triggers
			[], // reminder triggers
		]
		await runner.start()

		// Simulate a session failure event
		// eventHandler queries for matching triggers (entity_type=session), then sessionEventHandler looks up the session
		mockResults.selectQueue = [
			[], // eventHandler: no triggers match entity_type=session
			[{ triggerId: 'trigger-1' }], // sessionEventHandler: session lookup
		]

		bridge.emit('event', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			action: 'session_failed',
			entity_type: 'session',
			entity_id: 'session-1',
			event_id: 'evt-fail-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Now try to fire the trigger — it should be in backoff
		mockResults.select = [trigger]
		mockResults.insert = []

		bridge.emit('event', {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-2',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})

	it('allows trigger firing after backoff period expires', async () => {
		const trigger = buildTrigger({
			id: 'trigger-1',
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		// Simulate one failure (backoff = 2 min for count=1)
		mockResults.selectQueue = [
			[], // eventHandler: no triggers match entity_type=session
			[{ triggerId: 'trigger-1' }], // sessionEventHandler: session lookup
		]
		bridge.emit('event', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			action: 'session_failed',
			entity_type: 'session',
			entity_id: 'session-1',
			event_id: 'evt-fail-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Advance past the 2-minute backoff
		await vi.advanceTimersByTimeAsync(2 * 60_000 + 1000)

		// Now the trigger should fire
		mockResults.select = [trigger]
		mockResults.insert = []

		bridge.emit('event', {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-3',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).toHaveBeenCalled()
	})

	it('resets backoff on successful session', async () => {
		const trigger = buildTrigger({
			id: 'trigger-1',
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		// Simulate a failure
		mockResults.selectQueue = [
			[], // eventHandler: no triggers match entity_type=session
			[{ triggerId: 'trigger-1' }], // sessionEventHandler: session lookup
		]
		bridge.emit('event', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			action: 'session_failed',
			entity_type: 'session',
			entity_id: 'session-1',
			event_id: 'evt-fail-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Simulate a success (from a different session on the same trigger)
		mockResults.selectQueue = [
			[], // eventHandler: no triggers match entity_type=session
			[{ triggerId: 'trigger-1' }], // sessionEventHandler: session lookup
		]
		bridge.emit('event', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			action: 'session_completed',
			entity_type: 'session',
			entity_id: 'session-2',
			event_id: 'evt-success-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Trigger should fire immediately — no backoff
		mockResults.select = [trigger]
		mockResults.insert = []

		bridge.emit('event', {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-3',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).toHaveBeenCalled()
	})

	it('increases backoff duration with consecutive failures', async () => {
		mockResults.selectQueue = [[], []]
		await runner.start()

		// Simulate 3 consecutive failures
		for (let i = 1; i <= 3; i++) {
			mockResults.selectQueue = [
				[], // eventHandler: no triggers match entity_type=session
				[{ triggerId: 'trigger-1' }], // sessionEventHandler: session lookup
			]
			bridge.emit('event', {
				workspace_id: 'ws-1',
				actor_id: 'actor-1',
				action: 'session_failed',
				entity_type: 'session',
				entity_id: `session-${i}`,
				event_id: `evt-fail-${i}`,
			} satisfies PgEvent)
			await vi.advanceTimersByTimeAsync(0)
		}

		const trigger = buildTrigger({
			id: 'trigger-1',
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
		})

		// After 3 failures, backoff = 2^3 * 60s = 8 minutes
		// Advance 4 minutes — should still be in backoff
		await vi.advanceTimersByTimeAsync(4 * 60_000)

		mockResults.select = [trigger]
		mockResults.insert = []

		bridge.emit('event', {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-4',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).not.toHaveBeenCalled()

		// Advance past 8 minutes total — should now fire
		await vi.advanceTimersByTimeAsync(5 * 60_000)

		mockResults.select = [trigger]
		bridge.emit('event', {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-5',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).toHaveBeenCalled()
	})

	it('clears backoff when trigger is updated', async () => {
		const trigger = buildTrigger({
			id: 'trigger-1',
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		// Simulate a failure
		mockResults.selectQueue = [
			[], // eventHandler: no triggers match entity_type=session
			[{ triggerId: 'trigger-1' }], // sessionEventHandler: session lookup
		]
		bridge.emit('event', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			action: 'session_failed',
			entity_type: 'session',
			entity_id: 'session-1',
			event_id: 'evt-fail-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Now update the trigger (re-enable it)
		mockResults.selectQueue = [[trigger]]
		bridge.emit('event', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			action: 'updated',
			entity_type: 'trigger',
			entity_id: 'trigger-1',
			event_id: 'evt-update-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Now the trigger should fire — backoff was cleared
		mockResults.select = [trigger]
		mockResults.insert = []

		bridge.emit('event', {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			event_id: 'evt-3',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		expect(sessionManager.createSession).toHaveBeenCalled()
	})

	it('skips cron trigger firing when in backoff', async () => {
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		const trigger = buildTrigger({
			id: 'trigger-cron-1',
			type: 'cron',
			config: { expression: '*/1 * * * *' },
		})
		mockResults.selectQueue = [
			[trigger], // cron triggers
			[], // reminder triggers
		]
		mockResults.insert = []
		await runner.start()

		// Fire once to confirm it works
		await vi.advanceTimersByTimeAsync(60 * 1000)
		expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockClear()

		// Simulate a session failure for this trigger
		mockResults.selectQueue = [
			[], // eventHandler: no triggers match entity_type=session
			[{ triggerId: 'trigger-cron-1' }], // sessionEventHandler: session lookup
		]
		bridge.emit('event', {
			workspace_id: trigger.workspaceId,
			actor_id: 'actor-1',
			action: 'session_failed',
			entity_type: 'session',
			entity_id: 'session-1',
			event_id: 'evt-fail-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Next cron tick (1 minute later) — should be skipped due to backoff
		await vi.advanceTimersByTimeAsync(60 * 1000)
		expect(sessionManager.createSession).not.toHaveBeenCalled()
	})
})

describe('TriggerRunner circuit breaker', () => {
	let runner: TriggerRunner
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: ReturnType<typeof createMockSessionManager>
	let mockResults: Record<string, unknown>
	let dbCalls: {
		inserts: Array<{ table: unknown; values: unknown }>
		updates: Array<{ table: unknown; set: unknown }>
	}

	function wrapDbWithTracking(db: ReturnType<typeof createTestContext>['db']): typeof db {
		dbCalls = { inserts: [], updates: [] }
		return new Proxy(db, {
			get(target, prop) {
				if (prop === 'insert') {
					return (table: unknown) => {
						const chain = (target as unknown as Record<string, (t: unknown) => unknown>).insert(
							table,
						) as Record<string, (v: unknown) => unknown>
						const originalValues = chain.values
						chain.values = (values: unknown) => {
							dbCalls.inserts.push({ table, values })
							return originalValues(values)
						}
						return chain
					}
				}
				if (prop === 'update') {
					return (table: unknown) => {
						const chain = (target as unknown as Record<string, (t: unknown) => unknown>).update(
							table,
						) as Record<string, (v: unknown) => unknown>
						const originalSet = chain.set
						chain.set = (set: unknown) => {
							dbCalls.updates.push({ table, set })
							return originalSet(set)
						}
						return chain
					}
				}
				return (target as unknown as Record<string | symbol, unknown>)[prop]
			},
		})
	}

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		const ctx = createTestContext()
		mockResults = ctx.mockResults
		const wrappedDb = wrapDbWithTracking(ctx.db)
		runner = new TriggerRunner(wrappedDb, bridge, sessionManager)
		;(sessionManager.createSession as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: 'session-x',
		})
	})

	afterEach(async () => {
		await runner.stop()
		vi.useRealTimers()
	})

	async function emitFailures(count: number, triggerFixture: ReturnType<typeof buildTrigger>) {
		for (let i = 1; i <= count; i++) {
			mockResults.selectQueue = [
				[], // eventHandler: no triggers match entity_type=session
				// sessionEventHandler session lookup
				[{ triggerId: triggerFixture.id, result: { error: `error-${i}` } }],
				// openCircuit (only consumed on the threshold hit) — safe to leave; extra entries are ignored
				[triggerFixture],
			]
			bridge.emit('event', {
				workspace_id: triggerFixture.workspaceId,
				actor_id: 'actor-1',
				action: 'session_failed',
				entity_type: 'session',
				entity_id: `session-${i}`,
				event_id: `evt-fail-${i}`,
			} satisfies PgEvent)
			await vi.advanceTimersByTimeAsync(0)
		}
	}

	it('disables trigger after threshold consecutive failures', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-1',
			workspaceId: 'ws-1',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
			enabled: true,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		await emitFailures(CIRCUIT_BREAKER_THRESHOLD, trigger)

		// An update setting enabled=false should have been issued
		const triggerDisables = dbCalls.updates.filter(
			(u) => (u.set as { enabled?: boolean }).enabled === false,
		)
		expect(triggerDisables).toHaveLength(1)
	})

	it('creates an alert notification on circuit break', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-2',
			workspaceId: 'ws-1',
			name: 'My Failing Trigger',
			type: 'event',
			enabled: true,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		await emitFailures(CIRCUIT_BREAKER_THRESHOLD, trigger)

		const notificationInserts = dbCalls.inserts.filter(
			(i) => (i.values as { type?: string }).type === 'alert',
		)
		expect(notificationInserts).toHaveLength(1)
		const notif = notificationInserts[0].values as {
			title: string
			content: string
			workspaceId: string
			status: string
		}
		expect(notif.title).toContain('My Failing Trigger')
		expect(notif.title).toContain(String(CIRCUIT_BREAKER_THRESHOLD))
		expect(notif.content).toContain('error-5')
		expect(notif.workspaceId).toBe('ws-1')
		expect(notif.status).toBe('pending')
	})

	it('logs a trigger_circuit_broken audit event', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-3',
			workspaceId: 'ws-1',
			type: 'event',
			enabled: true,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		await emitFailures(CIRCUIT_BREAKER_THRESHOLD, trigger)

		const auditEvents = dbCalls.inserts.filter(
			(i) => (i.values as { action?: string }).action === 'trigger_circuit_broken',
		)
		expect(auditEvents).toHaveLength(1)
		const ev = auditEvents[0].values as {
			entityId: string
			data: { failure_count: number }
		}
		expect(ev.entityId).toBe('trigger-cb-3')
		expect(ev.data.failure_count).toBe(CIRCUIT_BREAKER_THRESHOLD)
	})

	it('does not re-open the circuit on further failures', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-4',
			workspaceId: 'ws-1',
			type: 'event',
			enabled: true,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		await emitFailures(CIRCUIT_BREAKER_THRESHOLD + 2, trigger)

		const notificationInserts = dbCalls.inserts.filter(
			(i) => (i.values as { type?: string }).type === 'alert',
		)
		expect(notificationInserts).toHaveLength(1)
	})

	it('does not open circuit before threshold is reached', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-5',
			workspaceId: 'ws-1',
			type: 'event',
			enabled: true,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		await emitFailures(CIRCUIT_BREAKER_THRESHOLD - 1, trigger)

		const notificationInserts = dbCalls.inserts.filter(
			(i) => (i.values as { type?: string }).type === 'alert',
		)
		expect(notificationInserts).toHaveLength(0)

		const triggerDisables = dbCalls.updates.filter(
			(u) => (u.set as { enabled?: boolean }).enabled === false,
		)
		expect(triggerDisables).toHaveLength(0)
	})

	it('resets failure count when trigger is re-enabled (update event)', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-6',
			workspaceId: 'ws-1',
			type: 'event',
			enabled: true,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		// Accumulate failures below threshold
		await emitFailures(CIRCUIT_BREAKER_THRESHOLD - 1, trigger)

		// Trigger update event (e.g., PATCH re-enables or modifies the trigger)
		mockResults.selectQueue = [[trigger]]
		bridge.emit('event', {
			workspace_id: trigger.workspaceId,
			actor_id: 'actor-1',
			action: 'updated',
			entity_type: 'trigger',
			entity_id: trigger.id,
			event_id: 'evt-update-1',
		} satisfies PgEvent)
		await vi.advanceTimersByTimeAsync(0)

		// Now emit threshold-1 more failures — should not break the circuit because counter was reset
		await emitFailures(CIRCUIT_BREAKER_THRESHOLD - 1, trigger)

		const notificationInserts = dbCalls.inserts.filter(
			(i) => (i.values as { type?: string }).type === 'alert',
		)
		expect(notificationInserts).toHaveLength(0)
	})

	it('skips breaking if the trigger is already disabled externally', async () => {
		const trigger = buildTrigger({
			id: 'trigger-cb-7',
			workspaceId: 'ws-1',
			type: 'event',
			enabled: false,
		})

		mockResults.selectQueue = [[], []]
		await runner.start()

		await emitFailures(CIRCUIT_BREAKER_THRESHOLD, trigger)

		// No disable update should be issued (already disabled)
		const triggerDisables = dbCalls.updates.filter(
			(u) => (u.set as { enabled?: boolean }).enabled === false,
		)
		expect(triggerDisables).toHaveLength(0)

		// No notification
		const notificationInserts = dbCalls.inserts.filter(
			(i) => (i.values as { type?: string }).type === 'alert',
		)
		expect(notificationInserts).toHaveLength(0)
	})
})

describe('evaluateCondition()', () => {
	it('is_set: true when field has value', () => {
		expect(
			evaluateCondition(
				{ field: 'priority', operator: 'is_set' },
				{ metadata: { priority: 'high' } },
			),
		).toBe(true)
	})

	it('is_set: false when field is null', () => {
		expect(
			evaluateCondition(
				{ field: 'priority', operator: 'is_set' },
				{ metadata: { priority: null } },
			),
		).toBe(false)
	})

	it('is_not_set: true when field missing', () => {
		expect(evaluateCondition({ field: 'priority', operator: 'is_not_set' }, { metadata: {} })).toBe(
			true,
		)
	})

	it('equals: loose comparison', () => {
		expect(
			evaluateCondition(
				{ field: 'count', operator: 'equals', value: 5 },
				{ metadata: { count: 5 } },
			),
		).toBe(true)
	})

	it('not_equals', () => {
		expect(
			evaluateCondition(
				{ field: 'count', operator: 'not_equals', value: 5 },
				{ metadata: { count: 10 } },
			),
		).toBe(true)
	})

	it('greater_than', () => {
		expect(
			evaluateCondition(
				{ field: 'score', operator: 'greater_than', value: 50 },
				{ metadata: { score: 75 } },
			),
		).toBe(true)
	})

	it('less_than', () => {
		expect(
			evaluateCondition(
				{ field: 'score', operator: 'less_than', value: 50 },
				{ metadata: { score: 25 } },
			),
		).toBe(true)
	})

	it('before: date comparison', () => {
		expect(
			evaluateCondition(
				{ field: 'due', operator: 'before', value: '2025-06-01' },
				{ metadata: { due: '2025-05-01' } },
			),
		).toBe(true)
	})

	it('after: date comparison', () => {
		expect(
			evaluateCondition(
				{ field: 'due', operator: 'after', value: '2025-01-01' },
				{ metadata: { due: '2025-06-01' } },
			),
		).toBe(true)
	})

	it('within_days: date within range', () => {
		const futureDate = new Date(Date.now() + 2 * 86_400_000).toISOString()
		expect(
			evaluateCondition(
				{ field: 'due', operator: 'within_days', value: 5 },
				{ metadata: { due: futureDate } },
			),
		).toBe(true)
	})

	it('within_days: date out of range', () => {
		const pastDate = new Date(Date.now() - 86_400_000).toISOString()
		expect(
			evaluateCondition(
				{ field: 'due', operator: 'within_days', value: 5 },
				{ metadata: { due: pastDate } },
			),
		).toBe(false)
	})

	it('contains: string inclusion', () => {
		expect(
			evaluateCondition(
				{ field: 'tags', operator: 'contains', value: 'urgent' },
				{ metadata: { tags: 'urgent,important' } },
			),
		).toBe(true)
	})

	it('contains: array inclusion', () => {
		expect(
			evaluateCondition(
				{ field: 'tags', operator: 'contains', value: 'urgent' },
				{ metadata: { tags: ['urgent', 'important'] } },
			),
		).toBe(true)
	})

	it('contains: array exclusion', () => {
		expect(
			evaluateCondition(
				{ field: 'tags', operator: 'contains', value: 'critical' },
				{ metadata: { tags: ['urgent', 'important'] } },
			),
		).toBe(false)
	})

	it('unknown operator returns false', () => {
		expect(
			evaluateCondition({ field: 'x', operator: 'unknown_op', value: 1 }, { metadata: { x: 1 } }),
		).toBe(false)
	})
})

describe('evaluateConditions()', () => {
	it('returns true when all conditions match', () => {
		expect(
			evaluateConditions(
				[
					{ field: 'a', operator: 'is_set' },
					{ field: 'b', operator: 'equals', value: 'x' },
				],
				{ metadata: { a: 1, b: 'x' } },
			),
		).toBe(true)
	})

	it('returns false when any condition fails', () => {
		expect(
			evaluateConditions(
				[
					{ field: 'a', operator: 'is_set' },
					{ field: 'b', operator: 'equals', value: 'x' },
				],
				{ metadata: { a: 1, b: 'y' } },
			),
		).toBe(false)
	})
})

describe('getObjectFromData()', () => {
	it('extracts current/previous from update event data', () => {
		const data = {
			previous: { status: 'todo' },
			updated: { status: 'done' },
		}

		const result = getObjectFromData(data)
		expect(result.current?.status).toBe('done')
		expect(result.previous?.status).toBe('todo')
	})

	it('extracts current from create event data', () => {
		const data = { status: 'new' }

		const result = getObjectFromData(data)
		expect(result.current?.status).toBe('new')
		expect(result.previous).toBeUndefined()
	})

	it('returns empty for null data', () => {
		const result = getObjectFromData(null)
		expect(result).toEqual({})
	})
})
