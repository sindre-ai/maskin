import { events, objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { applyVoiceEvent } from '../../lib/outreach/voice/apply'
import type { QueuedContact } from '../../lib/outreach/voice/dialer'
import { createDrizzleDialerStore } from '../../lib/outreach/voice/dialer-store'
import { createDrizzleStaleClaimStore } from '../../lib/outreach/voice/stale-claim-store'
import { runStaleClaimSweep } from '../../lib/outreach/voice/stale-claim-sweep'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// db is assigned by the harness's beforeAll, so the store is built on first use.
let cached: ReturnType<typeof createDrizzleStaleClaimStore> | undefined
function staleStore() {
	cached ??= createDrizzleStaleClaimStore(db)
	return cached
}
const minutes = (n: number) => n * 60_000
const inMinutes = (n: number) => new Date(Date.now() + minutes(n))

async function freshWorkspace() {
	return insertWorkspace(db, getTestActorId())
}

async function seedContact(workspaceId: string, status: string, metadata = {}, type = 'contact') {
	const row = await insertObject(db, workspaceId, getTestActorId(), {
		type,
		status,
		metadata: { owner: 'sebk', phone: '+4520123456', ...metadata },
	})
	if (!row) throw new Error('seed failed')
	return row
}

/** A contact claimed by the real dialer store: status voice_dialing, dial_attempt_n bumped, claim event written. */
async function claimedContact(workspaceId: string, metadata = {}) {
	const row = await seedContact(workspaceId, 'voice_queued', metadata)
	const queued: QueuedContact = {
		id: row.id,
		status: 'voice_queued',
		metadata: (row.metadata ?? null) as Record<string, unknown> | null,
		nextDialAt: null,
	}
	const claimed = await createDrizzleDialerStore(db).claim(
		workspaceId,
		queued,
		getTestActorId(),
		new Date(),
	)
	expect(claimed).toBe(true)
	return row
}

async function rowOf(id: string) {
	const [row] = await db.select().from(objects).where(eq(objects.id, id))
	return row
}

async function eventsOf(entityId: string) {
	return db.select().from(events).where(eq(events.entityId, entityId))
}

function deps(over = {}) {
	const deadLetter = vi.fn(async () => {})
	return {
		d: {
			store: staleStore(),
			thresholdMinutes: 15,
			actorId: getTestActorId(),
			deadLetter,
			...over,
		},
		deadLetter,
	}
}

describe('voice stale-claim sweep against real Postgres', () => {
	it('sweeps a stale claim to voice_failed with the end reason, an event, a summary and an alert', async () => {
		const ws = await freshWorkspace()
		const stuck = await claimedContact(ws.id, { dial_attempt_n: 1 })
		const { d, deadLetter } = deps({ now: () => inMinutes(20) })

		const result = await runStaleClaimSweep(d)

		const row = await rowOf(stuck.id)
		expect(row?.status).toBe('voice_failed')
		expect(row?.metadata).toMatchObject({
			voice_end_reason: 'claim_unconfirmed',
			dial_attempt_n: 2,
		})
		const sweepRows = (await eventsOf(stuck.id)).filter(
			(e) => (e.data as { source?: string } | null)?.source === 'voice_stale_claim_sweep',
		)
		expect(sweepRows).toHaveLength(1)
		expect(sweepRows[0]).toMatchObject({
			action: 'status_changed',
			actorId: getTestActorId(),
			data: {
				fromStatus: 'voice_dialing',
				toStatus: 'voice_failed',
				voice_end_reason: 'claim_unconfirmed',
				claim_time_source: 'claim_event',
				threshold_minutes: 15,
			},
		})
		expect(sweepRows[0]?.data).not.toHaveProperty('voice_event')
		const summaries = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.action, 'voice_stale_claim_sweep')))
		expect(summaries).toHaveLength(1)
		expect(summaries[0]?.data).toMatchObject({ examined_count: 1, swept_count: 1 })
		expect(result.swept_count).toBe(1)
		expect(deadLetter).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId: ws.id, contactId: stuck.id, dialAttemptN: 2 }),
			'claim never confirmed by a call.initiated webhook',
		)
	})

	it('skips a fresh claim', async () => {
		const ws = await freshWorkspace()
		const fresh = await claimedContact(ws.id)
		const { d } = deps({ now: () => inMinutes(5) })

		await runStaleClaimSweep(d)

		expect((await rowOf(fresh.id))?.status).toBe('voice_dialing')
	})

	it('skips a contact whose call.initiated webhook arrived, even when the claim is old', async () => {
		const ws = await freshWorkspace()
		const ringing = await claimedContact(ws.id)
		// The reducer takes the webhook: status stays voice_dialing, a telnyx_webhook row is written.
		await applyVoiceEvent(db, {
			workspaceId: ws.id,
			contactId: ringing.id,
			event: { type: 'call_initiated', callId: 'call-1', dialAttemptN: 1 },
		})
		const { d, deadLetter } = deps({ now: () => inMinutes(120) })

		await runStaleClaimSweep(d)

		expect((await rowOf(ringing.id))?.status).toBe('voice_dialing')
		expect(deadLetter).not.toHaveBeenCalled()
	})

	it('skips a contact the reducer has moved on from voice_dialing', async () => {
		const ws = await freshWorkspace()
		const answered = await claimedContact(ws.id)
		await applyVoiceEvent(db, {
			workspaceId: ws.id,
			contactId: answered.id,
			event: { type: 'call_initiated', callId: 'call-2', dialAttemptN: 1 },
		})
		await applyVoiceEvent(db, {
			workspaceId: ws.id,
			contactId: answered.id,
			event: { type: 'call_answered', callId: 'call-2' },
		})
		const { d } = deps({ now: () => inMinutes(120) })

		await runStaleClaimSweep(d)

		expect((await rowOf(answered.id))?.status).toBe('voice_answered')
	})

	it('a webhook that lands between the read and the write wins: zero rows, nothing swept', async () => {
		const ws = await freshWorkspace()
		const racing = await claimedContact(ws.id)
		const read = (await staleStore().readDialing()).find((c) => c.contactId === racing.id)
		expect(read).toMatchObject({ webhookAfterClaim: false, claimSource: 'claim_event' })

		await applyVoiceEvent(db, {
			workspaceId: ws.id,
			contactId: racing.id,
			event: { type: 'call_initiated', callId: 'call-3', dialAttemptN: 1 },
		})
		const swept = await staleStore().sweep(
			read as NonNullable<typeof read>,
			getTestActorId(),
			inMinutes(60),
			15,
		)

		expect(swept).toBe(false)
		expect((await rowOf(racing.id))?.status).toBe('voice_dialing')
		expect(
			(await eventsOf(racing.id)).filter(
				(e) => (e.data as { source?: string } | null)?.source === 'voice_stale_claim_sweep',
			),
		).toHaveLength(0)
	})

	it('a contact that left voice_dialing between the read and the write is not touched', async () => {
		const ws = await freshWorkspace()
		const moved = await claimedContact(ws.id)
		const read = (await staleStore().readDialing()).find((c) => c.contactId === moved.id)
		await db.update(objects).set({ status: 'voice_answered' }).where(eq(objects.id, moved.id))

		expect(
			await staleStore().sweep(
				read as NonNullable<typeof read>,
				getTestActorId(),
				inMinutes(60),
				15,
			),
		).toBe(false)
		expect((await rowOf(moved.id))?.status).toBe('voice_answered')
	})

	it('late call.initiated after the sweep moves the contact to voice_dialing; the next sweep skips it and nothing is queued', async () => {
		const ws = await freshWorkspace()
		const stuck = await claimedContact(ws.id)
		const { d, deadLetter } = deps({ now: () => inMinutes(20) })
		await runStaleClaimSweep(d)
		expect((await rowOf(stuck.id))?.status).toBe('voice_failed')

		const late = await applyVoiceEvent(db, {
			workspaceId: ws.id,
			contactId: stuck.id,
			event: { type: 'call_initiated', callId: 'call-late', dialAttemptN: 1 },
		})
		expect(late).toMatchObject({ found: true, applied: true, status: 'voice_dialing' })
		expect((await rowOf(stuck.id))?.status).toBe('voice_dialing')

		deadLetter.mockClear()
		const next = await runStaleClaimSweep({ ...d, now: () => inMinutes(60) })

		expect(next.swept_count).toBe(0)
		expect((await rowOf(stuck.id))?.status).toBe('voice_dialing')
		expect(deadLetter).not.toHaveBeenCalled()
		const statuses = (await eventsOf(stuck.id)).map(
			(e) => (e.data as { toStatus?: string } | null)?.toStatus,
		)
		expect(statuses).not.toContain('voice_queued')
	})

	it('falls back to updated_at when no claim event exists', async () => {
		const ws = await freshWorkspace()
		const orphan = await seedContact(ws.id, 'voice_dialing', { dial_attempt_n: 1 })
		const read = (await staleStore().readDialing()).find((c) => c.contactId === orphan.id)
		expect(read).toMatchObject({ claimSource: 'updated_at', claimEventId: null })
		const { d } = deps({ now: () => inMinutes(20) })

		await runStaleClaimSweep(d)

		expect((await rowOf(orphan.id))?.status).toBe('voice_failed')
		const sweepRow = (await eventsOf(orphan.id)).find(
			(e) => (e.data as { source?: string } | null)?.source === 'voice_stale_claim_sweep',
		)
		expect(sweepRow?.data).toMatchObject({ claim_time_source: 'updated_at' })
	})

	it('only reads contacts in voice_dialing, in any workspace, and never touches other types or statuses', async () => {
		const wsA = await freshWorkspace()
		const wsB = await freshWorkspace()
		const stuckA = await claimedContact(wsA.id)
		const stuckB = await claimedContact(wsB.id)
		const queued = await seedContact(wsA.id, 'voice_queued')
		const notAContact = await seedContact(wsA.id, 'voice_dialing', {}, 'task')
		const { d } = deps({ now: () => inMinutes(20) })

		await runStaleClaimSweep(d)

		expect((await rowOf(stuckA.id))?.status).toBe('voice_failed')
		expect((await rowOf(stuckB.id))?.status).toBe('voice_failed')
		expect((await rowOf(queued.id))?.status).toBe('voice_queued')
		expect((await rowOf(notAContact.id))?.status).toBe('voice_dialing')
	})
})
