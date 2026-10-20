import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	type ApnsRequest,
	ApnsSender,
	LIVE_ACTIVITY_ATTRIBUTES_TYPE,
	buildLiveActivityPayload,
} from '../../services/apns'
import {
	type WorkingAgent,
	encodeAgentsState,
	groupWorkingAgents,
	rankWorkingAgents,
	toSwiftReferenceSeconds,
} from '../../services/live-activity-agents'
import { LiveActivityFanout } from '../../services/live-activity-push'
import { createTestContext } from '../setup'

const NOW_MS = Date.parse('2026-10-03T10:05:00Z')
const agent = (over: Partial<WorkingAgent> = {}): WorkingAgent => ({
	id: 'a1',
	sessionId: 's1',
	name: 'Chief of Staff',
	doing: 'Reading the brief',
	startedAt: new Date('2026-10-03T10:00:00Z'),
	...over,
})
const base = { workspaceId: 'ws-1', agents: [agent()] }

describe('encodeAgentsState', () => {
	it('encodes exactly the keys AgentsActivityState / WorkingAgent decode, optionals omitted', () => {
		const state = encodeAgentsState([agent()], NOW_MS)
		expect(Object.keys(state).sort()).toEqual(['agents', 'count', 'finishingSoon'])
		expect(Object.keys(state.agents[0] as object).sort()).toEqual([
			'doing',
			'id',
			'name',
			'sessionId',
			'startedAt',
			'touchesCustomersOrProduction',
		])
	})

	it('encodes dates as seconds since the Swift reference date', () => {
		expect(toSwiftReferenceSeconds(new Date('2001-01-01T00:00:00Z'))).toBe(0)
		const state = encodeAgentsState(
			[agent({ expectedFinishAt: new Date('2001-01-01T00:10:00Z') })],
			NOW_MS,
		)
		expect(state.agents[0]?.startedAt).toBe(
			toSwiftReferenceSeconds(new Date('2026-10-03T10:00:00Z')),
		)
		expect(state.agents[0]?.expectedFinishAt).toBe(600)
	})

	it('clamps like the Swift side: blank falls back, long text ends with an ellipsis, topic max 60', () => {
		const [row] = encodeAgentsState(
			[
				agent({
					name: ' ',
					doing: '  ',
					topic: 't'.repeat(100),
				}),
			],
			NOW_MS,
		).agents
		expect(row?.name).toBe('Agent')
		expect(row?.doing).toBe('working')
		expect(row?.topic).toHaveLength(60)
		expect(row?.topic?.endsWith('…')).toBe(true)
		const long = encodeAgentsState(
			[agent({ name: 'n'.repeat(90), doing: 'd'.repeat(200) })],
			NOW_MS,
		)
		expect(long.agents[0]?.name).toHaveLength(40)
		expect(long.agents[0]?.doing).toHaveLength(80)
		expect(
			'topic' in (encodeAgentsState([agent({ topic: '  ' })], NOW_MS).agents[0] as object),
		).toBe(false)
	})

	it('keeps count for the whole set, at most 6 rows, and stays under the byte budget', () => {
		const many = Array.from({ length: 23 }, (_, i) =>
			agent({
				id: `a${i}`,
				sessionId: `s${i}`,
				name: 'n'.repeat(90),
				doing: 'd'.repeat(200),
				topic: 't'.repeat(100),
				conversationId: '11111111-1111-4111-8111-111111111111',
				objectId: '22222222-2222-4222-8222-222222222222',
			}),
		)
		const state = encodeAgentsState(many, NOW_MS)
		expect(state.count).toBe(23)
		expect(state.agents.length).toBeLessThanOrEqual(6)
		expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThanOrEqual(3000)
	})

	it('counts finishing-soon over the whole set', () => {
		const soon = new Date(NOW_MS + 5 * 60_000)
		const later = new Date(NOW_MS + 60 * 60_000)
		const state = encodeAgentsState(
			[
				agent({ id: 'a', expectedFinishAt: soon }),
				agent({ id: 'b', expectedFinishAt: later }),
				agent({ id: 'c' }),
			],
			NOW_MS,
		)
		expect(state.finishingSoon).toBe(1)
	})
})

describe('rankWorkingAgents', () => {
	it('ranks soonest finish, then customer/production, then longest-running, then id', () => {
		const t = (m: number) => new Date(NOW_MS + m * 60_000)
		const ranked = rankWorkingAgents([
			agent({ id: 'e', startedAt: t(-1) }),
			agent({ id: 'd', startedAt: t(-9) }),
			agent({ id: 'c', touchesCustomersOrProduction: true, startedAt: t(-1) }),
			agent({ id: 'b', expectedFinishAt: t(20) }),
			agent({ id: 'a', expectedFinishAt: t(5) }),
		])
		expect(ranked.map((a) => a.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
	})
})

describe('groupWorkingAgents', () => {
	it('folds an agent’s sessions into one row, the one that started first', () => {
		const row = (sessionId: string, actorId: string, minute: number) => ({
			sessionId,
			actorId,
			agentName: actorId,
			currentActivity: null,
			startedAt: new Date(NOW_MS + minute * 60_000),
			conversationId: null,
			topic: null,
		})
		const grouped = groupWorkingAgents([row('s2', 'a', 5), row('s1', 'a', 1), row('s3', 'b', 2)])
		expect(grouped.map((g) => [g.id, g.sessionId]).sort()).toEqual([
			['a', 's1'],
			['b', 's3'],
		])
	})
})

describe('buildLiveActivityPayload', () => {
	const build = (event: 'start' | 'update' | 'end', agents = base.agents) =>
		(
			buildLiveActivityPayload({ workspaceId: 'ws-1', event, agents }, NOW_MS) as {
				aps: Record<string, unknown>
			}
		).aps

	it('start carries attributes-type, workspace attributes, an alert and a stale-date', () => {
		const aps = build('start')
		expect(aps.event).toBe('start')
		expect(aps['attributes-type']).toBe(LIVE_ACTIVITY_ATTRIBUTES_TYPE)
		expect(aps['attributes-type']).toBe('MaskinAgentsAttributes')
		expect(aps.attributes).toEqual({ workspaceId: 'ws-1' })
		expect(aps.alert).toEqual({ title: 'Chief of Staff', body: 'Reading the brief' })
		expect(aps.timestamp).toBe(Math.floor(NOW_MS / 1000))
		expect(aps['stale-date']).toBe(Math.floor(NOW_MS / 1000) + 15 * 60)
		expect(aps['dismissal-date']).toBeUndefined()
	})

	it('start for several agents says how many', () => {
		expect(build('start', [agent({ id: 'a' }), agent({ id: 'b' })]).alert).toEqual({
			title: '2 agents working',
		})
	})

	it('update has no start-only keys and never an alert', () => {
		const aps = build('update')
		expect(aps['attributes-type']).toBeUndefined()
		expect(aps.attributes).toBeUndefined()
		expect(aps.alert).toBeUndefined()
		expect(aps['stale-date']).toBeDefined()
	})

	it('end is count 0 with a 60 s dismissal-date instead of a stale-date', () => {
		const aps = build('end', [])
		expect(aps['content-state']).toEqual({ count: 0, finishingSoon: 0, agents: [] })
		expect(aps['dismissal-date']).toBe(Math.floor(NOW_MS / 1000) + 60)
		expect(aps['stale-date']).toBeUndefined()
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

	it('sends updates at low priority and start/end at high priority', async () => {
		const { sender, sent } = make(200)
		const target = { token: 'ab', environment: 'sandbox' }
		await sender.sendLiveActivity(target, { ...base, event: 'update' })
		await sender.sendLiveActivity(target, { ...base, event: 'end' })
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

describe('LiveActivityFanout step-update throttling', () => {
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
		const syncSpy = vi.fn().mockResolvedValue(undefined)
		;(fanout as unknown as { sync: unknown }).sync = syncSpy
		const ev = (action: string, entityId = 's1') => ({
			workspace_id: 'ws',
			actor_id: 'a',
			action,
			entity_type: 'session',
			entity_id: entityId,
			event_id: '1',
		})
		return {
			fanout,
			syncSpy,
			ev,
			advance: (ms: number) => {
				clock += ms
			},
		}
	}

	it('syncs the first step change at once and collapses a burst into one trailing sync', async () => {
		vi.useFakeTimers()
		const { fanout, syncSpy, ev, advance } = setup()
		await fanout.handleEvent(ev('session_updated'))
		expect(syncSpy).toHaveBeenCalledTimes(1)
		await fanout.handleEvent(ev('session_updated'))
		await fanout.handleEvent(ev('session_updated'))
		expect(syncSpy).toHaveBeenCalledTimes(1)
		advance(5000)
		await vi.advanceTimersByTimeAsync(5000)
		expect(syncSpy).toHaveBeenCalledTimes(2)
	})

	it('syncs lifecycle edges immediately, bypassing the throttle, and cancels a queued trailing sync', async () => {
		vi.useFakeTimers()
		const { fanout, syncSpy, ev } = setup()
		await fanout.handleEvent(ev('session_updated'))
		await fanout.handleEvent(ev('session_updated'))
		await fanout.handleEvent(ev('session_completed'))
		expect(syncSpy).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(syncSpy).toHaveBeenCalledTimes(2)
	})

	it('ignores non-session events and does nothing when APNs is off', async () => {
		const { fanout, syncSpy, ev } = setup()
		await fanout.handleEvent({ ...ev('created'), entity_type: 'notification' })
		expect(syncSpy).not.toHaveBeenCalled()
		const { db } = createTestContext()
		const off = new LiveActivityFanout(
			db,
			new EventEmitter() as never,
			{ isEnabled: () => false } as unknown as ApnsSender,
		)
		const spy = vi.fn()
		;(off as unknown as { sync: unknown }).sync = spy
		await off.handleEvent(ev('session_started'))
		expect(spy).not.toHaveBeenCalled()
	})
})
