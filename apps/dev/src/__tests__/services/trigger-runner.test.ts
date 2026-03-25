import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import { buildTrigger } from '../factories'
import { createTestContext, createMockSessionManager } from '../setup'
import {
	TriggerRunner,
	evaluateCondition,
	evaluateConditions,
	getObjectFromEvent,
} from '../../services/trigger-runner'
import type { PgEvent, PgNotifyBridge } from '@ai-native/realtime'

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
	})

	describe('handleEvent()', () => {
		const baseEvent: PgEvent = {
			workspace_id: 'ws-1',
			entity_type: 'task',
			entity_id: 'obj-1',
			action: 'created',
			actor_id: 'actor-1',
			data: null,
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
			mockResults.select = [trigger]

			const event = { ...baseEvent, data: { priority: 'low' } }
			bridge.emit('event', event)
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
			mockResults.select = [trigger]
			mockResults.insert = []

			const event: PgEvent = {
				...baseEvent,
				action: 'updated',
				data: {
					previous: { status: 'todo' },
					updated: { status: 'in_progress' },
				},
			}
			bridge.emit('event', event)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).toHaveBeenCalled()
		})
	})

	describe('cron scheduling', () => {
		it('fires cron trigger at interval', async () => {
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
})

describe('evaluateCondition()', () => {
	it('is_set: true when field has value', () => {
		expect(
			evaluateCondition({ field: 'priority', operator: 'is_set' }, { metadata: { priority: 'high' } }),
		).toBe(true)
	})

	it('is_set: false when field is null', () => {
		expect(
			evaluateCondition({ field: 'priority', operator: 'is_set' }, { metadata: { priority: null } }),
		).toBe(false)
	})

	it('is_not_set: true when field missing', () => {
		expect(
			evaluateCondition({ field: 'priority', operator: 'is_not_set' }, { metadata: {} }),
		).toBe(true)
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

	it('unknown operator returns false', () => {
		expect(
			evaluateCondition(
				{ field: 'x', operator: 'unknown_op', value: 1 },
				{ metadata: { x: 1 } },
			),
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

describe('getObjectFromEvent()', () => {
	it('extracts current/previous from update event', () => {
		const event = {
			data: {
				previous: { status: 'todo' },
				updated: { status: 'done' },
			},
		} as any

		const result = getObjectFromEvent(event)
		expect(result.current?.status).toBe('done')
		expect(result.previous?.status).toBe('todo')
	})

	it('extracts current from create event', () => {
		const event = {
			data: { status: 'new' },
		} as any

		const result = getObjectFromEvent(event)
		expect(result.current?.status).toBe('new')
		expect(result.previous).toBeUndefined()
	})

	it('returns empty for null data', () => {
		const event = { data: null } as any
		const result = getObjectFromEvent(event)
		expect(result).toEqual({})
	})
})
