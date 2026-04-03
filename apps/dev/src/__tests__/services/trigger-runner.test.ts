import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'
import { vi } from 'vitest'
import {
	TriggerRunner,
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
			expect(bridge.listenerCount('event')).toBe(1)
		})
	})

	describe('stop()', () => {
		it('clears all intervals and timeouts', async () => {
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
		it('fires cron trigger at scheduled time', async () => {
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

		it('fires standard cron expression at correct time', async () => {
			// Set fake time to 08:59:00 so that "0 9 * * *" fires at 09:00
			vi.setSystemTime(new Date('2026-03-30T08:59:00'))

			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: '0 9 * * *' },
			})
			mockResults.selectQueue = [
				[trigger], // cron triggers
				[], // reminder triggers
			]
			mockResults.insert = []
			await runner.start()

			// Should not fire yet
			expect(sessionManager.createSession).not.toHaveBeenCalled()

			// Advance 60s to reach 09:00 — croner checks on the minute boundary
			await vi.advanceTimersByTimeAsync(60 * 1000)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})

		it('logs error for invalid cron expression', async () => {
			const trigger = buildTrigger({
				type: 'cron',
				config: { expression: 'not-a-cron' },
			})
			mockResults.selectQueue = [
				[trigger], // cron triggers
				[], // reminder triggers
			]
			await runner.start()

			// Should not throw, just log
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
