import { sessionDispatchAttempts } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { type DispatchFn, SessionDispatchQueue } from '../../services/session-dispatch-queue'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Sessions waiting for a machine must start oldest first. The claim used to
// order by next_attempt_at, which every no_capacity result pushed back, so a
// row's place in line reset on each try and younger rows overtook older ones.
// Real Postgres because the order comes from the claim's SELECT FOR UPDATE
// SKIP LOCKED query, which the in-memory fake only imitates.
describe('SessionDispatchQueue — waiting rows start oldest first (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	/** Enqueues one waiting session per entry, oldest first, and returns the session ids in that order. */
	async function enqueueWaiting(queue: SessionDispatchQueue, count: number): Promise<string[]> {
		const ids: string[] = []
		for (let i = 0; i < count; i++) {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'starting',
				sessionState: 'waiting_for_machine',
			})
			await queue.enqueue(session.id)
			// Distinct, increasing ages regardless of how fast the inserts ran.
			await db
				.update(sessionDispatchAttempts)
				.set({ createdAt: new Date(Date.now() - (count - i) * 60_000) })
				.where(eq(sessionDispatchAttempts.sessionId, session.id))
			ids.push(session.id)
		}
		return ids
	}

	async function queueRow(sessionId: string) {
		const [row] = await db
			.select()
			.from(sessionDispatchAttempts)
			.where(eq(sessionDispatchAttempts.sessionId, sessionId))
		return row
	}

	it('gives a freed slot to the oldest row even when a younger row became ready first', async () => {
		const dispatchFn = vi.fn<DispatchFn>(async () => ({ kind: 'no_capacity' }))
		const queue = new SessionDispatchQueue(db, dispatchFn, { tickMs: 1_000_000 })
		const [oldest, middle, youngest] = await enqueueWaiting(queue, 3)
		if (!oldest || !middle || !youngest) throw new Error('sessions missing')

		// Park all three, as the shared agent server being full does.
		await queue.tick()
		expect(dispatchFn).toHaveBeenCalledTimes(3)
		for (const id of [oldest, middle, youngest]) {
			const row = await queueRow(id)
			expect(row?.attempt).toBe(0)
			// Parked just under the 5s tick, so the next tick sees every row ready.
			expect((row?.nextAttemptAt.getTime() ?? Number.POSITIVE_INFINITY) - Date.now()).toBeLessThan(
				5_000,
			)
		}

		// The youngest row became ready first; the oldest is the last to be ready.
		const now = Date.now()
		for (const [i, id] of [oldest, middle, youngest].entries()) {
			await db
				.update(sessionDispatchAttempts)
				.set({ nextAttemptAt: new Date(now - 1_000 - (2 - i) * 1_000) })
				.where(eq(sessionDispatchAttempts.sessionId, id))
		}

		// One slot frees: only the first start call gets it.
		dispatchFn.mockReset()
		dispatchFn.mockResolvedValueOnce({ kind: 'dispatched' })
		dispatchFn.mockResolvedValue({ kind: 'no_capacity' })
		await queue.tick()

		expect(dispatchFn.mock.calls.map(([sessionId]) => sessionId)).toEqual([
			oldest,
			middle,
			youngest,
		])
		expect(await queueRow(oldest)).toBeUndefined()
		expect(await queueRow(middle)).toBeDefined()
		expect(await queueRow(youngest)).toBeDefined()
	})

	it('still tries rows from a workspace with room when the oldest rows are all refused', async () => {
		const dispatchFn = vi.fn<DispatchFn>(async () => ({ kind: 'no_capacity' }))
		// Batch of 2 and three refused rows ahead of the one that can start.
		const queue = new SessionDispatchQueue(db, dispatchFn, { tickMs: 1_000_000, batchSize: 2 })
		const [capped1, capped2, capped3, free] = await enqueueWaiting(queue, 4)
		if (!capped1 || !capped2 || !capped3 || !free) throw new Error('sessions missing')
		dispatchFn.mockImplementation(async (sessionId) =>
			sessionId === free ? { kind: 'dispatched' } : { kind: 'no_capacity' },
		)

		await queue.tick()

		// Each row is tried once: the refused ones don't use up the batch or get
		// claimed again in the same tick.
		expect(dispatchFn.mock.calls.map(([sessionId]) => sessionId)).toEqual([
			capped1,
			capped2,
			capped3,
			free,
		])
		expect(await queueRow(free)).toBeUndefined()
		for (const id of [capped1, capped2, capped3]) expect((await queueRow(id))?.attempt).toBe(0)
	})
})
