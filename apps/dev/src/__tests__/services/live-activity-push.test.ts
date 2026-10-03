import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	type ApnsRequest,
	ApnsSender,
	LIVE_ACTIVITY_STEP_MAX,
	buildLiveActivityPayload,
	toSwiftReferenceSeconds,
} from '../../services/apns'
import { LIVE_ACTIVITY_MAX_TRACKED, LiveActivityFanout } from '../../services/live-activity-push'
import { createTestContext } from '../setup'

const startedAt = new Date('2026-10-03T10:00:00Z')
const base = {
	sessionId: 'sess-1',
	workspaceId: 'ws-1',
	conversationId: 'conv-1',
	agentName: 'Chief of Staff',
	step: 'Reading the brief',
	startedAt,
	status: 'running' as const,
}
const NOW_MS = Date.parse('2026-10-03T10:05:00Z')

describe('buildLiveActivityPayload', () => {
	it('start carries attributes-type, attributes, an alert and the exact content-state keys', () => {
		const { aps } = buildLiveActivityPayload({ ...base, event: 'start' }, NOW_MS) as {
			aps: Record<string, unknown>
		}
		expect(aps.event).toBe('start')
		expect(aps['attributes-type']).toBe('MaskinTurnAttributes')
		expect(aps.attributes).toEqual({
			sessionId: 'sess-1',
			workspaceId: 'ws-1',
			conversationId: 'conv-1',
		})
		expect(aps.alert).toEqual({ title: 'Chief of Staff', body: 'Reading the brief' })
		expect(Object.keys(aps['content-state'] as object).sort()).toEqual([
			'agentName',
			'sessionId',
			'startedAt',
			'status',
			'step',
		])
		expect(aps.timestamp).toBe(Math.floor(NOW_MS / 1000))
	})

	it('encodes startedAt as seconds since the Swift reference date', () => {
		expect(toSwiftReferenceSeconds(new Date('2001-01-01T00:00:00Z'))).toBe(0)
		const { aps } = buildLiveActivityPayload({ ...base, event: 'update' }, NOW_MS) as {
			aps: { 'content-state': { startedAt: number } }
		}
		expect(aps['content-state'].startedAt).toBe(toSwiftReferenceSeconds(startedAt))
	})

	it('update has no start-only keys; end carries a dismissal-date instead of stale-date', () => {
		const update = (
			buildLiveActivityPayload({ ...base, event: 'update' }, NOW_MS) as never as {
				aps: Record<string, unknown>
			}
		).aps
		expect(update['attributes-type']).toBeUndefined()
		expect(update.alert).toBeUndefined()
		expect(update['stale-date']).toBeGreaterThan(update.timestamp as number)

		const end = (
			buildLiveActivityPayload({ ...base, event: 'end', status: 'done' }, NOW_MS) as never as {
				aps: Record<string, unknown>
			}
		).aps
		expect(end['dismissal-date']).toBeGreaterThan(end.timestamp as number)
		expect(end['stale-date']).toBeUndefined()
	})

	it('falls back to a status label, truncates the step and keeps the payload small', () => {
		const { aps } = buildLiveActivityPayload(
			{ ...base, event: 'update', step: 'x'.repeat(5000), agentName: 'A'.repeat(500) },
			NOW_MS,
		) as { aps: { 'content-state': { step: string; agentName: string } } }
		expect(aps['content-state'].step.length).toBeLessThanOrEqual(LIVE_ACTIVITY_STEP_MAX)
		expect(aps['content-state'].agentName.length).toBeLessThanOrEqual(40)

		const empty = buildLiveActivityPayload(
			{ ...base, event: 'update', step: '  ', status: 'needsYou' },
			NOW_MS,
		) as { aps: { 'content-state': { step: string } } }
		expect(empty.aps['content-state'].step).toBe('Needs you')
		expect(
			Buffer.byteLength(
				JSON.stringify(buildLiveActivityPayload({ ...base, event: 'start' }, NOW_MS)),
			),
		).toBeLessThan(1000)
	})
})

describe('ApnsSender.sendLiveActivity', () => {
	const config = { keyId: 'K', teamId: 'T', privateKey: 'unused', bundleId: 'io.maskin.app' }
	const make = (status: number, body = '') => {
		const sent: ApnsRequest[] = []
		const { db } = createTestContext()
		const sender = new ApnsSender(db, {
			config,
			transport: {
				send: async (r) => {
					sent.push(r)
					return { status, body }
				},
			},
		})
		;(sender as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		return { sender, sent }
	}

	it('uses the liveactivity push type and the .push-type.liveactivity topic', async () => {
		const { sender, sent } = make(200)
		const res = await sender.sendLiveActivity(
			{ token: 'ab', environment: 'production' },
			{ ...base, event: 'start' },
		)
		expect(res).toBe('sent')
		expect(sent[0]?.host).toBe('api.push.apple.com')
		expect(sent[0]?.headers['apns-push-type']).toBe('liveactivity')
		expect(sent[0]?.headers['apns-topic']).toBe('io.maskin.app.push-type.liveactivity')
		expect(sent[0]?.headers['apns-priority']).toBe('10')
	})

	it('sends routine updates at low priority and alerting updates at high priority', async () => {
		const { sender, sent } = make(200)
		const target = { token: 'ab', environment: 'sandbox' }
		await sender.sendLiveActivity(target, { ...base, event: 'update' })
		await sender.sendLiveActivity(target, {
			...base,
			event: 'update',
			status: 'needsYou',
			alert: { title: 'Approve?' },
		})
		expect(sent.map((r) => r.headers['apns-priority'])).toEqual(['5', '10'])
		expect(sent[0]?.host).toBe('api.sandbox.push.apple.com')
	})

	it('reports dead tokens (410 / BadDeviceToken) and never throws on transport errors', async () => {
		expect(
			await make(410, '{"reason":"Unregistered"}').sender.sendLiveActivity(
				{ token: 'a', environment: 'sandbox' },
				{ ...base, event: 'update' },
			),
		).toBe('dead')
		expect(
			await make(400, '{"reason":"BadDeviceToken"}').sender.sendLiveActivity(
				{ token: 'a', environment: 'sandbox' },
				{ ...base, event: 'update' },
			),
		).toBe('dead')
		expect(
			await make(429, '{"reason":"TooManyRequests"}').sender.sendLiveActivity(
				{ token: 'a', environment: 'sandbox' },
				{ ...base, event: 'update' },
			),
		).toBe('failed')
		const { db } = createTestContext()
		const boom = new ApnsSender(db, {
			config,
			transport: {
				send: async () => {
					throw new Error('net')
				},
			},
		})
		;(boom as unknown as { providerToken: () => string }).providerToken = () => 'jwt'
		expect(
			await boom.sendLiveActivity(
				{ token: 'a', environment: 'sandbox' },
				{ ...base, event: 'end' },
			),
		).toBe('failed')
	})

	it('is a no-op when APNs is not configured', async () => {
		const { db } = createTestContext()
		const sender = new ApnsSender(db, { config: null })
		expect(
			await sender.sendLiveActivity(
				{ token: 'a', environment: 'sandbox' },
				{ ...base, event: 'start' },
			),
		).toBe('disabled')
	})
})

describe('LiveActivityFanout throttling', () => {
	afterEach(() => vi.useRealTimers())

	function setup() {
		const { db } = createTestContext()
		const sender = { isEnabled: () => true, sendLiveActivity: vi.fn() }
		let clock = 1_000_000
		const fanout = new LiveActivityFanout(
			db,
			new EventEmitter() as never,
			sender as unknown as ApnsSender,
			{ throttleMs: 5000, now: () => clock },
		)
		const pushSpy = vi.fn().mockResolvedValue(undefined)
		;(fanout as unknown as { push: unknown }).push = pushSpy
		const ev = (action: string) => ({
			workspace_id: 'ws',
			actor_id: 'a',
			action,
			entity_type: 'session',
			entity_id: 's1',
			event_id: '1',
		})
		return {
			fanout,
			pushSpy,
			ev,
			advance: (ms: number) => {
				clock += ms
			},
		}
	}

	it('sends the first update at once and collapses a burst into one trailing update', async () => {
		vi.useFakeTimers()
		const { fanout, pushSpy, ev, advance } = setup()
		await fanout.handleEvent(ev('session_updated'))
		expect(pushSpy).toHaveBeenCalledTimes(1)

		advance(1000)
		await fanout.handleEvent(ev('session_updated'))
		await fanout.handleEvent(ev('session_updated'))
		expect(pushSpy).toHaveBeenCalledTimes(1)

		advance(4000)
		await vi.advanceTimersByTimeAsync(4000)
		expect(pushSpy).toHaveBeenCalledTimes(2)
		fanout.stop()
	})

	it('ends immediately and cancels a queued trailing update', async () => {
		vi.useFakeTimers()
		const { fanout, pushSpy, ev, advance } = setup()
		await fanout.handleEvent(ev('session_updated'))
		advance(1000)
		await fanout.handleEvent(ev('session_updated'))
		await fanout.handleEvent(ev('session_completed'))
		expect(pushSpy).toHaveBeenLastCalledWith('s1', 'end', { endStatus: 'done' })
		await vi.advanceTimersByTimeAsync(10_000)
		expect(pushSpy).toHaveBeenCalledTimes(2)
		fanout.stop()
	})

	it('maps failure-like actions to a failed end and ignores unrelated ones', async () => {
		const { fanout, pushSpy, ev } = setup()
		for (const a of ['session_failed', 'session_timeout', 'session_budget_stopped']) {
			await fanout.handleEvent(ev(a))
		}
		expect(pushSpy.mock.calls.map((c) => c[2])).toEqual([
			{ endStatus: 'failed' },
			{ endStatus: 'failed' },
			{ endStatus: 'failed' },
		])
		pushSpy.mockClear()
		await fanout.handleEvent(ev('dispatch_entered'))
		expect(pushSpy).not.toHaveBeenCalled()
	})

	it('starts on session_started and session_resumed', async () => {
		const { fanout, pushSpy, ev } = setup()
		await fanout.handleEvent(ev('session_started'))
		await fanout.handleEvent(ev('session_resumed'))
		expect(pushSpy.mock.calls.map((c) => c[1])).toEqual(['start', 'start'])
	})

	it('clears throttle state on end and caps it for sessions that never end', async () => {
		const { fanout, ev } = setup()
		const pending = (fanout as unknown as { pending: Map<string, unknown> }).pending
		await fanout.handleEvent(ev('session_updated'))
		expect(pending.size).toBe(1)
		await fanout.handleEvent(ev('session_completed'))
		expect(pending.size).toBe(0)

		for (let i = 0; i < LIVE_ACTIVITY_MAX_TRACKED + 50; i++) {
			await fanout.handleEvent({ ...ev('session_updated'), entity_id: `s-${i}` })
		}
		expect(pending.size).toBeLessThanOrEqual(LIVE_ACTIVITY_MAX_TRACKED)
	})

	it('maps a finished turn to an end and a started turn to a start', async () => {
		const { fanout, pushSpy } = setup()
		await fanout.handleTurn({ sessionId: 's1', phase: 'started' })
		await fanout.handleTurn({ sessionId: 's1', phase: 'finished', outcome: 'failed' })
		expect(pushSpy.mock.calls.map((c) => [c[1], c[2]?.endStatus])).toEqual([
			['start', undefined],
			['end', 'failed'],
		])
	})
})
