import { describe, expect, it, vi } from 'vitest'
import type { DialerEvent } from '../../../lib/outreach/voice/dialer'
import {
	DEFAULT_STALE_CLAIM_MINUTES,
	type DialingContact,
	SWEEP_END_REASON,
	SWEEP_EVENT_SOURCE,
	SWEEP_REASON,
	type StaleClaimDeps,
	type StaleClaimStore,
	readStaleClaimMinutes,
	runStaleClaimSweep,
} from '../../../lib/outreach/voice/stale-claim-sweep'
import { advance } from '../../../lib/outreach/voice/state'

const T0 = new Date('2026-10-01T09:00:00Z')
const WS = '33333333-3333-4333-8333-333333333333'
const ACTOR = '44444444-4444-4444-8444-444444444444'
const minutes = (n: number) => n * 60_000

function id(n: number) {
	return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

interface World {
	status: string
	metadata: Record<string, unknown>
	claimedAt: Date
	claimEventId: number
	/** Id of a telnyx_webhook call_initiated row after the claim, if the webhook arrived. */
	webhookEventId?: number
}

interface FakeStore extends StaleClaimStore {
	world: Map<string, World>
	events: DialerEvent[]
	sweptEvents: { contactId: string; data: Record<string, unknown> }[]
	/** Zero-row conditional writes forced by a test (a webhook landing mid-sweep). */
	loseWriteFor: Set<string>
}

/** In-memory store whose sweep is conditional on status voice_dialing, like the SQL update. */
function fakeStore(contacts: Record<string, World>): FakeStore {
	const world = new Map(Object.entries(contacts))
	const store: FakeStore = {
		world,
		events: [],
		sweptEvents: [],
		loseWriteFor: new Set(),
		readDialing: async () =>
			[...world.entries()]
				.filter(([, w]) => w.status === 'voice_dialing')
				.map(
					([contactId, w]): DialingContact => ({
						workspaceId: WS,
						contactId,
						claimedAt: w.claimedAt,
						claimSource: 'claim_event',
						claimEventId: w.claimEventId,
						webhookAfterClaim: w.webhookEventId !== undefined && w.webhookEventId > w.claimEventId,
						dialAttemptN: Number(w.metadata.dial_attempt_n ?? 0),
					}),
				),
		sweep: async (contact, _actor, _now, thresholdMinutes) => {
			const w = world.get(contact.contactId)
			if (!w || w.status !== 'voice_dialing' || store.loseWriteFor.has(contact.contactId)) {
				return false
			}
			w.status = 'voice_failed'
			w.metadata = { ...w.metadata, voice_end_reason: SWEEP_END_REASON }
			store.sweptEvents.push({
				contactId: contact.contactId,
				data: {
					source: SWEEP_EVENT_SOURCE,
					reason: SWEEP_REASON,
					threshold_minutes: thresholdMinutes,
				},
			})
			return true
		},
		recordEvent: async (e) => {
			store.events.push(e)
		},
	}
	return store
}

function claimed(minutesAgo: number, over: Partial<World> = {}): World {
	return {
		status: 'voice_dialing',
		metadata: { dial_attempt_n: 2, owner: 'sebk' },
		claimedAt: new Date(T0.getTime() - minutes(minutesAgo)),
		claimEventId: 100,
		...over,
	}
}

function setup(store: FakeStore, over: Partial<StaleClaimDeps> = {}) {
	const deadLetter = vi.fn(async () => {})
	const deps: StaleClaimDeps = {
		store,
		thresholdMinutes: 15,
		actorId: ACTOR,
		deadLetter,
		now: () => T0,
		...over,
	}
	return { deps, deadLetter }
}

function summary(store: FakeStore) {
	const rows = store.events.filter((e) => e.action === SWEEP_EVENT_SOURCE)
	expect(rows).toHaveLength(1)
	return rows[0]?.data as Record<string, unknown>
}

describe('runStaleClaimSweep', () => {
	it('sweeps a stale voice_dialing contact to voice_failed with a legible reason and an alert', async () => {
		const store = fakeStore({ [id(1)]: claimed(20) })
		const { deps, deadLetter } = setup(store)

		const result = await runStaleClaimSweep(deps)

		const w = store.world.get(id(1))
		expect(w?.status).toBe('voice_failed')
		expect(w?.metadata.voice_end_reason).toBe('claim_unconfirmed')
		expect(store.sweptEvents).toEqual([
			{
				contactId: id(1),
				data: expect.objectContaining({
					source: 'voice_stale_claim_sweep',
					reason: 'claim never confirmed by a call.initiated webhook',
				}),
			},
		])
		expect(result.swept_count).toBe(1)
		expect(deadLetter).toHaveBeenCalledTimes(1)
		expect(deadLetter).toHaveBeenCalledWith(
			{ workspaceId: WS, contactId: id(1), actorId: ACTOR, dialAttemptN: 2 },
			'claim never confirmed by a call.initiated webhook',
		)
	})

	it('skips a fresh voice_dialing contact, and sweeps it once the threshold passes', async () => {
		const store = fakeStore({ [id(1)]: claimed(14) })
		const { deps, deadLetter } = setup(store)

		const first = await runStaleClaimSweep(deps)
		expect(first.swept_count).toBe(0)
		expect(store.world.get(id(1))?.status).toBe('voice_dialing')
		expect(deadLetter).not.toHaveBeenCalled()
		expect(summary(store)).toMatchObject({ examined_count: 1, swept_count: 0, fresh_count: 1 })

		store.events.length = 0
		const later = await runStaleClaimSweep({
			...deps,
			now: () => new Date(T0.getTime() + minutes(1)),
		})
		expect(later.swept_count).toBe(1)
		expect(store.world.get(id(1))?.status).toBe('voice_failed')
	})

	it('skips a contact the reducer already advanced (call.initiated webhook arrived)', async () => {
		const store = fakeStore({
			// Still voice_dialing, ringing: the webhook row is after the claim, however old the claim.
			[id(1)]: claimed(60, { webhookEventId: 150 }),
			// Moved on by the reducer: not voice_dialing, never read.
			[id(2)]: claimed(60, { status: 'voice_answered' }),
		})
		const { deps, deadLetter } = setup(store)

		const result = await runStaleClaimSweep(deps)

		expect(result.swept_count).toBe(0)
		expect(store.world.get(id(1))?.status).toBe('voice_dialing')
		expect(store.world.get(id(2))?.status).toBe('voice_answered')
		expect(deadLetter).not.toHaveBeenCalled()
		expect(summary(store)).toMatchObject({ examined_count: 1, swept_count: 0, confirmed_count: 1 })
	})

	it('does not count a webhook row from before the latest claim as arrival', async () => {
		// A previous attempt's webhook (id 50) is older than this claim (id 100): the retry is stuck.
		const store = fakeStore({ [id(1)]: claimed(20, { webhookEventId: 50 }) })
		const { deps } = setup(store)

		expect((await runStaleClaimSweep(deps)).swept_count).toBe(1)
	})

	it('skips a lost conditional write without error and without an alert', async () => {
		const store = fakeStore({ [id(1)]: claimed(20), [id(2)]: claimed(20) })
		store.loseWriteFor.add(id(1))
		const { deps, deadLetter } = setup(store)

		const result = await runStaleClaimSweep(deps)

		expect(result.swept_count).toBe(1)
		expect(store.world.get(id(1))?.status).toBe('voice_dialing')
		expect(store.world.get(id(2))?.status).toBe('voice_failed')
		expect(deadLetter).toHaveBeenCalledTimes(1)
		expect(summary(store)).toMatchObject({ examined_count: 2, swept_count: 1, lost_count: 1 })
	})

	it('keeps sweeping the rest when one contact write throws', async () => {
		const store = fakeStore({ [id(1)]: claimed(20), [id(2)]: claimed(20) })
		const realSweep = store.sweep
		store.sweep = async (c, ...rest) => {
			if (c.contactId === id(1)) throw new Error('db hiccup')
			return realSweep(c, ...rest)
		}
		const { deps } = setup(store)

		const result = await runStaleClaimSweep(deps)

		expect(result.swept_count).toBe(1)
		expect(store.world.get(id(2))?.status).toBe('voice_failed')
	})

	it('never produces voice_queued or any retry status, and leaves dial_attempt_n alone', async () => {
		const store = fakeStore({
			[id(1)]: claimed(20),
			[id(2)]: claimed(300, { metadata: { dial_attempt_n: 3 } }),
			[id(3)]: claimed(5),
		})
		const { deps } = setup(store)

		await runStaleClaimSweep(deps)
		await runStaleClaimSweep(deps)

		const retryOrQueued = ['voice_queued', 'voice_no_answer', 'voice_busy', 'voice_voicemail']
		for (const w of store.world.values()) expect(retryOrQueued).not.toContain(w.status)
		expect(store.world.get(id(1))?.metadata.dial_attempt_n).toBe(2)
		expect(store.world.get(id(2))?.metadata.dial_attempt_n).toBe(3)
		expect(store.world.get(id(3))?.status).toBe('voice_dialing')
	})

	it('writes one summary event per run with the swept count, never carrying a voice_event', async () => {
		const store = fakeStore({ [id(1)]: claimed(20), [id(2)]: claimed(20), [id(3)]: claimed(1) })
		const { deps } = setup(store)

		await runStaleClaimSweep(deps)

		const data = summary(store)
		expect(data).toMatchObject({
			source: 'voice_stale_claim_sweep',
			threshold_minutes: 15,
			examined_count: 3,
			swept_count: 2,
			fresh_count: 1,
		})
		expect(data.swept_contact_ids).toEqual([id(1), id(2)])
		// Read as webhook arrival by the next sweep if it carried voice_event call_initiated.
		expect(data).not.toHaveProperty('voice_event')
		expect(store.events[0]).toMatchObject({
			workspaceId: WS,
			actorId: ACTOR,
			entityType: 'workspace',
		})
	})

	it('writes nothing when no contact is in voice_dialing', async () => {
		const store = fakeStore({ [id(1)]: claimed(20, { status: 'voice_queued' }) })
		const { deps, deadLetter } = setup(store)

		const result = await runStaleClaimSweep(deps)

		expect(result).toMatchObject({ examined_count: 0, swept_count: 0, workspaces: [] })
		expect(store.events).toEqual([])
		expect(deadLetter).not.toHaveBeenCalled()
	})

	it('fails closed without the Sales Rep actor id: reads nothing, sweeps nothing', async () => {
		const store = fakeStore({ [id(1)]: claimed(20) })
		const readDialing = vi.spyOn(store, 'readDialing')
		const { deps } = setup(store, { actorId: null })

		const result = await runStaleClaimSweep(deps)

		expect(result.swept_count).toBe(0)
		expect(readDialing).not.toHaveBeenCalled()
		expect(store.world.get(id(1))?.status).toBe('voice_dialing')
	})

	it('still counts the contact as swept when the alert throws', async () => {
		const store = fakeStore({ [id(1)]: claimed(20) })
		const { deps } = setup(store, {
			deadLetter: async () => {
				throw new Error('slack down')
			},
		})

		const result = await runStaleClaimSweep(deps)

		expect(result.swept_count).toBe(1)
		expect(summary(store)).toMatchObject({ swept_count: 1 })
	})

	it('a late call.initiated after the sweep moves the contact to voice_dialing, the next sweep skips it, nothing is queued', async () => {
		const store = fakeStore({ [id(1)]: claimed(20) })
		const { deps, deadLetter } = setup(store)

		await runStaleClaimSweep(deps)
		const w = store.world.get(id(1)) as World
		expect(w.status).toBe('voice_failed')

		// The reducer (apply.ts) takes the late webhook: voice_failed is not absorbing.
		const late = advance(
			{ status: w.status, metadata: w.metadata },
			{ type: 'call_initiated', callId: 'call-late', dialAttemptN: 2 },
			T0,
		)
		expect(late.applied).toBe(true)
		expect(late.status).toBe('voice_dialing')
		w.status = late.status
		w.metadata = { ...w.metadata, ...late.metadata }
		w.webhookEventId = 200 // the reducer's telnyx_webhook row, after the claim (id 100)

		deadLetter.mockClear()
		store.events.length = 0
		const next = await runStaleClaimSweep({
			...deps,
			now: () => new Date(T0.getTime() + minutes(30)),
		})

		expect(next.swept_count).toBe(0)
		expect(w.status).toBe('voice_dialing')
		expect(w.status).not.toBe('voice_queued')
		expect(deadLetter).not.toHaveBeenCalled()
		expect(summary(store)).toMatchObject({ swept_count: 0, confirmed_count: 1 })
	})
})

describe('readStaleClaimMinutes', () => {
	it('defaults to 15 minutes when unset or empty', () => {
		expect(DEFAULT_STALE_CLAIM_MINUTES).toBe(15)
		expect(readStaleClaimMinutes({})).toBe(15)
		expect(readStaleClaimMinutes({ VOICE_STALE_CLAIM_MINUTES: '  ' })).toBe(15)
	})

	it('parses a positive integer', () => {
		expect(readStaleClaimMinutes({ VOICE_STALE_CLAIM_MINUTES: '30' })).toBe(30)
	})

	it('falls back to the default for zero, negative, fractional or non-numeric values', () => {
		for (const bad of ['0', '-5', '1.5', 'abc', 'NaN']) {
			expect(readStaleClaimMinutes({ VOICE_STALE_CLAIM_MINUTES: bad })).toBe(15)
		}
	})
})
