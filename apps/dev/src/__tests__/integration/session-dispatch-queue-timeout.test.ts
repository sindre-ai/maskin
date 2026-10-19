import { sessionDispatchAttempts, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import {
	type DispatchFn,
	type DispatchResult,
	SessionDispatchQueue,
	dispatchIdempotencyKey,
} from '../../services/session-dispatch-queue'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const MAX_ATTEMPTS = 3

// A start call that hangs must still cost an attempt, otherwise the row is
// re-leased every minute and sits in waiting_for_machine until the 24h
// session_waiting_stuck signal. Real Postgres because the assertions are on
// the persisted queue row and session across several claims, and the claim is
// a SELECT FOR UPDATE SKIP LOCKED transaction the in-memory fake only imitates.
describe('SessionDispatchQueue — timed-out starts spend an attempt (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function waitingSession() {
		return insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			sessionState: 'waiting_for_machine',
		})
	}

	// tickTimeoutMs is generous so the claim transaction always lands before the
	// tick is abandoned; leaseMs is long so only expireLease() makes the row ready again.
	function makeQueue(dispatchFn: DispatchFn) {
		return new SessionDispatchQueue(db, dispatchFn, {
			maxAttempts: MAX_ATTEMPTS,
			tickMs: 1_000_000,
			tickTimeoutMs: 250,
			leaseMs: 600_000,
			noCapacityBackoffMs: 600_000,
		})
	}

	async function queueRow(sessionId: string) {
		const [row] = await db
			.select()
			.from(sessionDispatchAttempts)
			.where(eq(sessionDispatchAttempts.sessionId, sessionId))
		return row
	}

	async function sessionRow(sessionId: string) {
		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		return row
	}

	/** Pretend the lease ran out (or the backoff passed) so the next tick may claim the row. */
	async function makeReady(sessionId: string) {
		await db
			.update(sessionDispatchAttempts)
			.set({ nextAttemptAt: new Date(Date.now() - 1_000) })
			.where(eq(sessionDispatchAttempts.sessionId, sessionId))
	}

	it('fails a session whose start call hangs on every tick, saying it timed out', async () => {
		const session = await waitingSession()
		const dispatchFn = vi.fn((): Promise<DispatchResult> => new Promise(() => {}))
		const queue = makeQueue(dispatchFn)
		await queue.enqueue(session.id)

		for (let tick = 1; tick <= MAX_ATTEMPTS; tick++) {
			await queue.tick()
			const row = await queueRow(session.id)
			expect(row?.attempt).toBe(tick)
			expect(row?.status).toBe('pending')
			expect((await sessionRow(session.id))?.status).toBe('starting')
			await makeReady(session.id)
		}
		expect(dispatchFn).toHaveBeenCalledTimes(MAX_ATTEMPTS)

		// Every start call has now gone unanswered: the next claim gives up
		// without making a fourth call.
		await queue.tick()

		expect(dispatchFn).toHaveBeenCalledTimes(MAX_ATTEMPTS)
		const row = await queueRow(session.id)
		expect(row?.status).toBe('failed')
		expect(row?.attempt).toBe(MAX_ATTEMPTS)
		expect(row?.lastError).toContain('timed out')

		const failed = await sessionRow(session.id)
		expect(failed?.status).toBe('failed')
		const result = failed?.result as { failure_reason?: { human_message: string } } | null
		expect(result?.failure_reason?.human_message).toContain('did not answer the start request')
	})

	it('does not burn attempts while a row only waits for capacity', async () => {
		const session = await waitingSession()
		const dispatchFn = vi.fn(async (): Promise<DispatchResult> => ({ kind: 'no_capacity' }))
		const queue = makeQueue(dispatchFn)
		await queue.enqueue(session.id)

		// More waits than MAX_ATTEMPTS: if each one spent an attempt the row would be failed.
		for (let tick = 1; tick <= MAX_ATTEMPTS + 2; tick++) {
			await queue.tick()
			const row = await queueRow(session.id)
			expect(row?.attempt).toBe(0)
			expect(row?.status).toBe('pending')
			await makeReady(session.id)
		}

		expect(dispatchFn).toHaveBeenCalledTimes(MAX_ATTEMPTS + 2)
		const waiting = await sessionRow(session.id)
		expect(waiting?.status).toBe('starting')
		expect(waiting?.sessionState).toBe('waiting_for_machine')
	})

	it('still starts a row that was slow on one tick', async () => {
		const session = await waitingSession()
		let calls = 0
		const dispatchFn = vi.fn(async (sessionId: string): Promise<DispatchResult> => {
			calls++
			if (calls === 1) return new Promise(() => {})
			// What SessionDispatcher.markDispatched does once the agent server answers.
			await db
				.update(sessions)
				.set({ status: 'running', sessionState: 'running' })
				.where(eq(sessions.id, sessionId))
			return { kind: 'dispatched' }
		})
		const queue = makeQueue(dispatchFn)
		await queue.enqueue(session.id)

		await queue.tick()
		expect((await queueRow(session.id))?.attempt).toBe(1)

		await makeReady(session.id)
		await queue.tick()

		expect(dispatchFn).toHaveBeenCalledTimes(2)
		expect(dispatchFn).toHaveBeenLastCalledWith(session.id, dispatchIdempotencyKey(session.id))
		expect(await queueRow(session.id)).toBeUndefined()
		const running = await sessionRow(session.id)
		expect(running?.status).toBe('running')
	})
})
