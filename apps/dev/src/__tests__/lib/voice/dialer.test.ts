import { describe, expect, it, vi } from 'vitest'
import { decodeClientState } from '../../../lib/integrations/providers/telnyx/client'
import {
	type DialerConfig,
	type DialerDeps,
	type DialerEvent,
	type DialerStore,
	type QueuedContact,
	copenhagenMidnight,
	runDialerTick,
} from '../../../lib/outreach/voice/dialer'
import { parseFounderActors } from '../../../lib/outreach/voice/dnc-gate'

// Thu 2026-10-01 11:00 CEST, inside the dial window.
const NOW = new Date('2026-10-01T09:00:00Z')
const WS = '33333333-3333-4333-8333-333333333333'
const ACTOR = '44444444-4444-4444-8444-444444444444'
const SEBK = '11111111-1111-4111-8111-111111111111'

function contact(n: number, over: Partial<QueuedContact> = {}): QueuedContact {
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
		status: 'voice_queued',
		nextDialAt: null,
		metadata: { owner: 'sebk', phone: `+45201234${String(n).padStart(2, '0')}` },
		...over,
	}
}

interface FakeStore extends DialerStore {
	events: DialerEvent[]
	stamps: { contactId: string; patch: Record<string, unknown> }[]
	failed: { contactId: string; reason: string }[]
	countCalls: Date[]
	rows: Map<string, QueuedContact>
	callInitiatedCount: number
}

/** In-memory store whose claim is atomic on (status, next_dial_at), like the SQL update. */
function fakeStore(
	queue: QueuedContact[],
	opts: { inLast60?: number; today?: number } = {},
): FakeStore {
	const rows = new Map(queue.map((c) => [c.id, { ...c }]))
	const store: FakeStore = {
		events: [],
		stamps: [],
		failed: [],
		countCalls: [],
		rows,
		callInitiatedCount: 0,
		// Copies, like a database read: a later claim must not change what an earlier tick read.
		readQueue: async (_ws, _now, limit) =>
			[...rows.values()].slice(0, limit).map((c) => ({ ...c })),
		claim: async (_ws, c) => {
			const row = rows.get(c.id)
			if (!row || row.status !== c.status || row.nextDialAt !== c.nextDialAt) return false
			row.status = 'voice_dialing'
			return true
		},
		countCallInitiated: async (_ws, since) => {
			store.countCalls.push(since)
			return since.getTime() === NOW.getTime() - 60_000 ? (opts.inLast60 ?? 0) : (opts.today ?? 0)
		},
		recordEvent: async (e) => {
			store.events.push(e)
			if (e.action === 'call_initiated') store.callInitiatedCount++
		},
		stampMetadata: async (_ws, contactId, patch) => {
			store.stamps.push({ contactId, patch })
			const row = rows.get(contactId)
			if (row) row.metadata = { ...row.metadata, ...patch }
		},
		failContact: async (_ws, contactId, reason) => {
			store.failed.push({ contactId, reason })
		},
	}
	return store
}

const CONFIG: DialerConfig = {
	rateLimitPerMinute: 5,
	dailyCap: 200,
	fromNumber: '+4570000000',
	assistantId: 'assistant-1',
	connectionId: 'app-1',
	webhookUrl: 'https://maskin.test/api/integrations/telnyx/webhook',
}

function setup(store: FakeStore, over: Partial<DialerDeps> = {}) {
	const createCall = vi.fn(async () => ({ callControlId: 'call-1', callSessionId: 'sess-1' }))
	const deps: DialerDeps = {
		store,
		telnyx: { createCall },
		gate: {
			founders: parseFounderActors(JSON.stringify({ sebk: SEBK })),
			findActor: async () => ({ type: 'human' }),
			robinson: { has: () => false },
		},
		config: CONFIG,
		autosendEnabled: true,
		actorId: ACTOR,
		now: () => NOW,
		...over,
	}
	return { deps, createCall }
}

const actions = (s: FakeStore) => s.events.map((e) => e.action)
const tickEvent = (s: FakeStore) => s.events.find((e) => e.action === 'dialer_tick')

describe('runDialerTick', () => {
	it('places a call with the contact id in client_state and the configured endpoints', async () => {
		const c = contact(1)
		const store = fakeStore([c])
		const { deps, createCall } = setup(store)

		const result = await runDialerTick(WS, deps)

		expect(createCall).toHaveBeenCalledTimes(1)
		const input = createCall.mock.calls[0]?.[0] as unknown as Parameters<
			typeof deps.telnyx.createCall
		>[0]
		expect(input).toMatchObject({
			to: '+4520123401',
			from: '+4570000000',
			assistantId: 'assistant-1',
			connectionId: 'app-1',
			webhookUrl: CONFIG.webhookUrl,
		})
		expect(input.clientState).toEqual({ contact_id: c.id, workspace_id: WS, dial_attempt_n: 1 })
		// The wire value is base64 JSON that decodes back to the same state.
		const wire = Buffer.from(JSON.stringify(input.clientState)).toString('base64')
		expect(decodeClientState(wire)).toEqual(input.clientState)
		expect(store.rows.get(c.id)?.status).toBe('voice_dialing')
		expect(result).toMatchObject({ dialed_count: 1, in_last_60s: 0, slots_remaining: 4 })
		expect(store.events.find((e) => e.action === 'call_initiated')).toMatchObject({
			entityId: c.id,
			actorId: ACTOR,
			data: { call_id: 'call-1', dial_attempt_n: 1 },
		})
	})

	it('numbers the attempt from the contact history', async () => {
		const c = contact(1, {
			status: 'voice_no_answer',
			nextDialAt: '2026-10-01T08:00:00.000Z',
			metadata: { owner: 'sebk', phone: '+4520123401', dial_attempt_n: 2 },
		})
		const { deps, createCall } = setup(fakeStore([c]))
		await runDialerTick(WS, deps)
		const input = createCall.mock.calls[0]?.[0] as unknown as {
			clientState: { dial_attempt_n: number }
		}
		expect(input.clientState.dial_attempt_n).toBe(3)
	})

	it('claims before it dials', async () => {
		const c = contact(1)
		const store = fakeStore([c])
		const { deps, createCall } = setup(store)
		createCall.mockImplementationOnce(async () => {
			expect(store.rows.get(c.id)?.status).toBe('voice_dialing')
			return { callControlId: 'call-1', callSessionId: null }
		})
		await runDialerTick(WS, deps)
		expect(createCall).toHaveBeenCalledTimes(1)
	})

	it('two ticks over one voice_queued contact place one call', async () => {
		const store = fakeStore([contact(1)])
		const { deps, createCall } = setup(store)
		const [a, b] = await Promise.all([runDialerTick(WS, deps), runDialerTick(WS, deps)])
		expect(createCall).toHaveBeenCalledTimes(1)
		expect(a.dialed_count + b.dialed_count).toBe(1)
		expect(a.claim_lost_count + b.claim_lost_count).toBe(1)
	})

	it('two ticks over one due retry contact place one call', async () => {
		const retry = contact(1, {
			status: 'voice_no_answer',
			nextDialAt: '2026-10-01T08:00:00.000Z',
			metadata: { owner: 'sebk', phone: '+4520123401', dial_attempt_n: 1 },
		})
		const store = fakeStore([retry])
		const { deps, createCall } = setup(store)
		const [a, b] = await Promise.all([runDialerTick(WS, deps), runDialerTick(WS, deps)])
		expect(createCall).toHaveBeenCalledTimes(1)
		expect(a.dialed_count + b.dialed_count).toBe(1)
	})

	it('skips a contact whose claim affects zero rows', async () => {
		const store = fakeStore([contact(1)])
		store.claim = async () => false
		const { deps, createCall } = setup(store)
		const result = await runDialerTick(WS, deps)
		expect(createCall).not.toHaveBeenCalled()
		expect(result).toMatchObject({ dialed_count: 0, claim_lost_count: 1 })
	})

	describe('pacing', () => {
		it('dials only the slots left in the rolling minute', async () => {
			const store = fakeStore(
				[1, 2, 3, 4, 5].map((n) => contact(n)),
				{ inLast60: 3 },
			)
			const { deps, createCall } = setup(store)
			const result = await runDialerTick(WS, deps)
			expect(createCall).toHaveBeenCalledTimes(2)
			expect(result).toMatchObject({ dialed_count: 2, in_last_60s: 3, slots_remaining: 0 })
		})

		it('skips the tick when the rolling minute is full', async () => {
			const store = fakeStore([contact(1)], { inLast60: 5 })
			const { deps, createCall } = setup(store)
			const result = await runDialerTick(WS, deps)
			expect(createCall).not.toHaveBeenCalled()
			expect(result.skipped_reason).toBe('rate_limited')
			expect(tickEvent(store)?.data).toMatchObject({
				skipped_reason: 'rate_limited',
				in_last_60s: 5,
			})
		})

		it('counts the day from 00:00 Copenhagen time', async () => {
			const store = fakeStore([contact(1)])
			const { deps } = setup(store)
			await runDialerTick(WS, deps)
			// 11:00 CEST on 2026-10-01: Copenhagen midnight is 22:00Z the day before.
			expect(copenhagenMidnight(NOW).toISOString()).toBe('2026-09-30T22:00:00.000Z')
			expect(store.countCalls.map((d) => d.toISOString())).toContain('2026-09-30T22:00:00.000Z')
		})

		it('never exceeds the daily cap', async () => {
			const store = fakeStore(
				[1, 2, 3].map((n) => contact(n)),
				{ today: 198 },
			)
			const { deps, createCall } = setup(store)
			const result = await runDialerTick(WS, deps)
			expect(createCall).toHaveBeenCalledTimes(2)
			expect(result.dialed_count).toBe(2)
		})

		it('skips the tick at the daily cap', async () => {
			const store = fakeStore([contact(1)], { today: 200 })
			const { deps, createCall } = setup(store)
			const result = await runDialerTick(WS, deps)
			expect(createCall).not.toHaveBeenCalled()
			expect(result.skipped_reason).toBe('daily_cap_reached')
		})
	})

	describe('with VOICE_OUTREACH_AUTOSEND off', () => {
		it('builds the queue, records a ready-to-dial summary and places no call', async () => {
			const queue = [contact(1), contact(2)]
			const store = fakeStore(queue)
			const claim = vi.spyOn(store, 'claim')
			const { deps, createCall } = setup(store, { autosendEnabled: false })

			const result = await runDialerTick(WS, deps)

			expect(createCall).not.toHaveBeenCalled()
			expect(claim).not.toHaveBeenCalled()
			expect(result).toMatchObject({ dialed_count: 0, ready_to_dial_count: 2 })
			expect(tickEvent(store)?.data).toMatchObject({
				skipped_reason: 'autosend_off',
				ready_to_dial_count: 2,
				ready_to_dial_contact_ids: queue.map((c) => c.id),
			})
			expect(store.rows.get(queue[0]?.id ?? '')?.status).toBe('voice_queued')
		})
	})

	describe('DNC gate in the tick', () => {
		it('writes an event with the reason, stamps the contact and moves on to the next one', async () => {
			const held = contact(1, {
				metadata: { owner: 'sebk', phone: '+4520123401', held_reason: 'legal' },
			})
			const ok = contact(2)
			const store = fakeStore([held, ok])
			const { deps, createCall } = setup(store)

			const result = await runDialerTick(WS, deps)

			expect(result).toMatchObject({ dialed_count: 1, refused_count: 1 })
			expect(createCall).toHaveBeenCalledTimes(1)
			const refusal = store.events.find((e) => e.action === 'dnc_refused')
			expect(refusal).toMatchObject({ entityId: held.id, data: { check: 'hold' } })
			expect(String(refusal?.data.reason)).toContain('held_reason')
			expect(store.stamps).toHaveLength(1)
			expect(store.rows.get(held.id)?.status).toBe('voice_queued')
		})

		it('stamps robinson_listed_at when the number is on the list', async () => {
			const store = fakeStore([contact(1)])
			const { deps, createCall } = setup(store)
			deps.gate.robinson = { has: () => true }
			await runDialerTick(WS, deps)
			expect(createCall).not.toHaveBeenCalled()
			expect(store.stamps[0]?.patch).toMatchObject({
				robinson_listed_at: NOW.toISOString(),
				dnc_refusal: { check: 'robinson' },
			})
		})

		it('does not repeat the event for a contact refused for the same reason on the previous tick', async () => {
			const store = fakeStore([
				contact(1, { metadata: { owner: 'sebk', phone: '+4520123401', approval_hold: true } }),
			])
			const { deps } = setup(store)
			await runDialerTick(WS, deps)
			await runDialerTick(WS, deps)
			expect(actions(store).filter((a) => a === 'dnc_refused')).toHaveLength(1)
			expect(store.stamps).toHaveLength(1)
		})

		it('does not let refused contacts eat the pacing budget', async () => {
			const refused = [1, 2, 3, 4, 5].map((n) =>
				contact(n, { metadata: { owner: 'rune', phone: '+4520123401' } }),
			)
			const store = fakeStore([...refused, contact(6), contact(7)])
			const { deps, createCall } = setup(store)
			const result = await runDialerTick(WS, deps)
			expect(result.dialed_count).toBe(2)
			expect(createCall).toHaveBeenCalledTimes(2)
		})
	})

	describe('Telnyx failure', () => {
		it('fails the contact with the reason, writes no call_initiated and stops the tick', async () => {
			const store = fakeStore([contact(1), contact(2)])
			const { deps, createCall } = setup(store)
			createCall.mockRejectedValueOnce(
				new Error('Telnyx POST /v2/calls failed after 3 attempts: HTTP 503'),
			)

			const result = await runDialerTick(WS, deps)

			expect(createCall).toHaveBeenCalledTimes(1)
			expect(store.failed).toEqual([
				{ contactId: contact(1).id, reason: expect.stringContaining('after 3 attempts') },
			])
			expect(actions(store)).not.toContain('call_initiated')
			expect(result.dialed_count).toBe(0)
			expect(store.rows.get(contact(2).id)?.status).toBe('voice_queued')
		})
	})

	describe('fail-closed preconditions', () => {
		it('places nothing and writes nothing when the Sales Rep actor is not configured', async () => {
			const store = fakeStore([contact(1)])
			const { deps, createCall } = setup(store, { actorId: null })
			const result = await runDialerTick(WS, deps)
			expect(createCall).not.toHaveBeenCalled()
			expect(store.events).toHaveLength(0)
			expect(result.skipped_reason).toBe('voice_actor_not_configured')
		})

		it.each([
			['fromNumber', { fromNumber: null }],
			['assistantId', { assistantId: null }],
			['connectionId', { connectionId: null }],
			['webhookUrl', { webhookUrl: null }],
		])('places nothing when %s is not configured', async (_name, patch) => {
			const store = fakeStore([contact(1)])
			const { deps, createCall } = setup(store, { config: { ...CONFIG, ...patch } })
			const result = await runDialerTick(WS, deps)
			expect(createCall).not.toHaveBeenCalled()
			expect(result.skipped_reason).toBe('telnyx_not_configured')
		})

		it('places nothing outside the Copenhagen workday window', async () => {
			const store = fakeStore([contact(1)])
			const readQueue = vi.spyOn(store, 'readQueue')
			// Saturday 11:00 CEST.
			const { deps, createCall } = setup(store, { now: () => new Date('2026-10-03T09:00:00Z') })
			const result = await runDialerTick(WS, deps)
			expect(createCall).not.toHaveBeenCalled()
			expect(readQueue).not.toHaveBeenCalled()
			expect(result.skipped_reason).toBe('outside_dial_window')
		})
	})

	it('emits a tick event with tick_at, dialed_count, in_last_60s and slots_remaining', async () => {
		const store = fakeStore([contact(1)], { inLast60: 1 })
		const { deps } = setup(store)
		await runDialerTick(WS, deps)
		const tick = tickEvent(store)
		expect(tick).toMatchObject({ entityType: 'workspace', entityId: WS, actorId: ACTOR })
		expect(tick?.data).toMatchObject({
			tick_at: NOW.toISOString(),
			dialed_count: 1,
			in_last_60s: 1,
			slots_remaining: 3,
		})
		expect(tick?.data.skipped_reason).toBeUndefined()
	})

	it('records an empty-queue tick with a reason', async () => {
		const store = fakeStore([])
		const { deps } = setup(store)
		const result = await runDialerTick(WS, deps)
		expect(result.skipped_reason).toBe('queue_empty')
		expect(tickEvent(store)?.data).toMatchObject({ skipped_reason: 'queue_empty' })
	})
})
