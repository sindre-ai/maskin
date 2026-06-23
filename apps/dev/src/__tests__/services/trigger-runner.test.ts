import { EventEmitter } from 'node:events'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { vi } from 'vitest'
import {
	TriggerRunner,
	calculateBackoffUntil,
	evaluateCondition,
	evaluateConditions,
	getObjectFromData,
	resolvePath,
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

		it('passes event.data through to the action prompt', async () => {
			const trigger = buildTrigger({
				workspaceId: 'ws-1',
				type: 'event',
				config: { entity_type: 'gmail.message', action: 'received' },
				actionPrompt: 'Read the gmail thread referenced in the event',
			})
			const eventData = { threadId: '19e410381018bd93', messageId: 'msg-abc' }
			mockResults.selectQueue = [
				[trigger], // matching triggers
				[{ data: eventData }], // fetchEventData
			]
			mockResults.insert = []

			bridge.emit('event', {
				...baseEvent,
				entity_type: 'gmail.message',
				action: 'received',
				entity_id: 'gmail-entity-1',
			} satisfies PgEvent)
			await vi.advanceTimersByTimeAsync(0)

			expect(sessionManager.createSession).toHaveBeenCalledOnce()
			const [, opts] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(opts.actionPrompt).toContain('19e410381018bd93')
			expect(opts.actionPrompt).toContain('msg-abc')
			expect(opts.actionPrompt).toContain('"data":')
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

		// AC-T6: Given an observability-class insight created with metadata.urgent=true,
		// when the dedicated immediate-triage trigger fires, then a session is created for
		// the Bug Triage actor (which then creates the signal bet). The four observability
		// sources mirror the CoolifySource + PosthogSource enums.
		describe('AC-T6: immediate-triage trigger fan-out', () => {
			const observabilityTriggerConfig = {
				entity_type: 'object',
				action: 'created',
				conditions: [
					{ field: 'urgent', operator: 'equals', value: true },
					{
						field: 'source',
						operator: 'in',
						value: ['coolify_deployment', 'coolify_crash', 'coolify_health', 'posthog_exception'],
					},
				],
			} as const

			const observabilityEvent: PgEvent = {
				workspace_id: 'ws-1',
				entity_type: 'object',
				entity_id: 'insight-1',
				action: 'created',
				actor_id: 'integration-actor',
				event_id: 'evt-obs-1',
			}

			it.each([
				'coolify_deployment',
				'coolify_crash',
				'coolify_health',
				'posthog_exception',
			] as const)('fires for an urgent insight from source=%s', async (source) => {
				const trigger = buildTrigger({
					workspaceId: 'ws-1',
					type: 'event',
					config: observabilityTriggerConfig,
					targetActorId: 'bug-triage-actor',
				})
				mockResults.selectQueue = [
					[trigger],
					[{ data: { source, fingerprint: 'fp-abc', urgent: true } }],
				]
				mockResults.insert = []

				bridge.emit('event', observabilityEvent)
				await vi.advanceTimersByTimeAsync(0)

				expect(sessionManager.createSession).toHaveBeenCalledOnce()
				const [, opts] = (sessionManager.createSession as ReturnType<typeof vi.fn>).mock.calls[0]
				expect(opts.actorId).toBe('bug-triage-actor')
				expect(opts.triggerId).toBe(trigger.id)
				expect(opts.actionPrompt).toContain(source)
			})

			it('does not fire when urgent flag is missing', async () => {
				const trigger = buildTrigger({
					workspaceId: 'ws-1',
					type: 'event',
					config: observabilityTriggerConfig,
				})
				mockResults.selectQueue = [
					[trigger],
					[{ data: { source: 'coolify_deployment', fingerprint: 'fp-x' } }],
				]

				bridge.emit('event', observabilityEvent)
				await vi.advanceTimersByTimeAsync(0)

				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})

			it('does not fire when source is outside the observability allowlist', async () => {
				const trigger = buildTrigger({
					workspaceId: 'ws-1',
					type: 'event',
					config: observabilityTriggerConfig,
				})
				mockResults.selectQueue = [[trigger], [{ data: { source: 'slack_mention', urgent: true } }]]

				bridge.emit('event', observabilityEvent)
				await vi.advanceTimersByTimeAsync(0)

				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})

			it('does not fire on an updated event (dedup occurrence path)', async () => {
				const trigger = buildTrigger({
					workspaceId: 'ws-1',
					type: 'event',
					config: observabilityTriggerConfig,
				})
				mockResults.select = [trigger]

				// PostHog dedup path emits action:'updated' to bump occurrence count —
				// the trigger must skip it so we don't re-create a bet per occurrence.
				bridge.emit('event', { ...observabilityEvent, action: 'updated' })
				await vi.advanceTimersByTimeAsync(0)

				expect(sessionManager.createSession).not.toHaveBeenCalled()
			})
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

	it('in: matches when value is in the array', () => {
		expect(
			evaluateCondition(
				{ field: 'event.channel', operator: 'in', value: ['C1', 'C2'] },
				{ event: { channel: 'C1' } },
			),
		).toBe(true)
	})

	it('in: does not match when value not in the array', () => {
		expect(
			evaluateCondition(
				{ field: 'event.channel', operator: 'in', value: ['C1', 'C2'] },
				{ event: { channel: 'C3' } },
			),
		).toBe(false)
	})

	it('in: returns false when value is non-array', () => {
		expect(
			evaluateCondition(
				{ field: 'event.channel', operator: 'in', value: 'C1' },
				{ event: { channel: 'C1' } },
			),
		).toBe(false)
	})

	it('in: returns false when field is undefined', () => {
		expect(
			evaluateCondition({ field: 'event.channel', operator: 'in', value: ['C1'] }, { event: {} }),
		).toBe(false)
	})

	it('not_in: matches when value not in the array', () => {
		expect(
			evaluateCondition(
				{ field: 'event.channel', operator: 'not_in', value: ['C1', 'C2'] },
				{ event: { channel: 'C3' } },
			),
		).toBe(true)
	})

	it('not_in: does not match when value is in the array', () => {
		expect(
			evaluateCondition(
				{ field: 'event.channel', operator: 'not_in', value: ['C1', 'C2'] },
				{ event: { channel: 'C1' } },
			),
		).toBe(false)
	})

	it('not_in: returns true when field is undefined', () => {
		expect(
			evaluateCondition(
				{ field: 'event.channel', operator: 'not_in', value: ['C1'] },
				{ event: {} },
			),
		).toBe(true)
	})

	it('resolves nested dotted paths (Slack reaction)', () => {
		expect(
			evaluateCondition(
				{ field: 'event.item.channel', operator: 'equals', value: 'C1' },
				{ event: { item: { channel: 'C1' } } },
			),
		).toBe(true)
	})

	it('backward compat: bare field name resolves via metadata fallback', () => {
		expect(
			evaluateCondition(
				{ field: 'priority', operator: 'equals', value: 'high' },
				{ metadata: { priority: 'high' } },
			),
		).toBe(true)
	})
})

describe('resolvePath()', () => {
	it('returns undefined when root is nullish', () => {
		expect(resolvePath(null, 'a')).toBeUndefined()
		expect(resolvePath(undefined, 'a')).toBeUndefined()
	})

	it('resolves top-level keys', () => {
		expect(resolvePath({ a: 1 }, 'a')).toBe(1)
	})

	it('resolves nested keys via dotted path', () => {
		expect(resolvePath({ a: { b: { c: 'x' } } }, 'a.b.c')).toBe('x')
	})

	it('returns undefined when a segment is missing', () => {
		expect(resolvePath({ a: { b: 1 } }, 'a.c')).toBeUndefined()
		expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined()
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
