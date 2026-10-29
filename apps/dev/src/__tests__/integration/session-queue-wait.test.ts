import { sessionDispatchAttempts, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionDispatchQueue } from '../../services/session-dispatch-queue'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// A session handed to the dispatch queue can wait well past the reaper's
// queued-rescue (2 min) and boot-stall (5 min) cutoffs when the agent servers
// are full. Before the fix it kept session_state='queued', was re-fired by
// queued-rescue, left in 'starting', and failed as startup_stalled although
// nothing was wrong with it. Real Postgres because the assertion is on the
// persisted row across startSession and a reaper pass.
describe('SessionManager.startSession — rows waiting in the dispatch queue (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('marks a queued-for-dispatch row waiting_for_machine and the reaper leaves it alone', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		// Enqueue succeeds but nothing ever dispatches the row, as when every
		// agent server is at its cap.
		manager.setDispatchQueue({
			async enqueue() {},
		} as unknown as SessionDispatchQueue)

		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId: agent.id,
				actionPrompt: 'wait for a slot',
				createdBy: actorId,
				autoStart: false,
			})
			sessionId = session.id
			await manager.startSession(sessionId)

			const [queued] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
			expect(queued?.status).toBe('starting')
			expect(queued?.sessionState).toBe('waiting_for_machine')

			// 20 min in the queue: past queued-rescue (2 min) and boot-stall (5 min).
			const waitedSince = new Date(Date.now() - 20 * 60 * 1000)
			await db
				.update(sessions)
				.set({ stateEnteredAt: waitedSince, updatedAt: waitedSince })
				.where(eq(sessions.id, sessionId))

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect(row?.status).toBe('starting')
		expect(row?.sessionState).toBe('waiting_for_machine')
	})

	// The waiting_for_machine mark must not switch off the queue's own give-up:
	// a row whose dispatch keeps failing has to end failed, not wait forever.
	it('still ends the session failed when the queue exhausts its attempts', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		const queue = new SessionDispatchQueue(
			db,
			async () => ({ kind: 'transient_failure', error: 'no agent server accepted it' }),
			{ maxAttempts: 1 },
		)
		manager.setDispatchQueue(queue)

		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId: agent.id,
				actionPrompt: 'queue gives up',
				createdBy: actorId,
				autoStart: false,
			})
			sessionId = session.id
			await manager.startSession(sessionId)

			const [waiting] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
			expect(waiting?.sessionState).toBe('waiting_for_machine')

			await queue.tick()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect(row?.status).toBe('failed')
		const [attempt] = await db
			.select()
			.from(sessionDispatchAttempts)
			.where(eq(sessionDispatchAttempts.sessionId, sessionId))
		expect(attempt?.status).toBe('failed')
	})
})

// A helper started from a chat with create_session sits at status 'queued' when
// the workspace session budget is full. Chat reports said such a helper died
// after about 10 minutes in the queue while a trigger-started one lasted an
// hour. Real Postgres because the assertion is on the persisted row across
// reaper passes.
describe('Chat-started helper waiting for a workspace slot (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, {
			settings: { max_concurrent_sessions: 1 },
		})
		workspaceId = ws.id
	})

	it('stays queued past 10 minutes through the reaper, then drains to the dispatch queue when a slot frees', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const holder = await insertActor(db, { type: 'agent' })
		const conversation = await insertConversation(db, workspaceId, actorId)
		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		manager.setDispatchQueue({
			async enqueue() {},
		} as unknown as SessionDispatchQueue)

		// The one slot is taken by a session waiting for a machine.
		const blocker = await insertSession(db, workspaceId, holder.id, actorId, {
			status: 'starting',
			sessionState: 'waiting_for_machine',
			containerId: null,
		})

		let sessionId: string
		try {
			// The config create_session builds for a helper started from a chat
			// (routes/sessions.ts): interactive, ends on its result, no conversation_id.
			const helper = await manager.createSession(workspaceId, {
				actorId: agent.id,
				actionPrompt: 'do the handed-over work',
				createdBy: actorId,
				autoStart: false,
				config: {
					interactive: true,
					stop_on_result: true,
					ask_conversation_id: conversation.id,
					origin_conversation_id: conversation.id,
					hop_depth: 1,
				},
			})
			sessionId = helper.id
			await manager.startSession(sessionId)

			const [queued] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
			expect(queued?.status).toBe('queued')

			// 20 min in the queue: past queued-rescue (2 min), boot-stall (5 min)
			// and the idle cutoff (10 min).
			const waitedSince = new Date(Date.now() - 20 * 60 * 1000)
			await db
				.update(sessions)
				.set({ stateEnteredAt: waitedSince, updatedAt: waitedSince })
				.where(eq(sessions.id, sessionId))

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			// queued-rescue re-drives the row without awaiting it; wait for it to
			// settle back to 'queued' before reading.
			await vi.waitFor(async () => {
				const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
				expect(row?.sessionState).toBe('queued')
				expect(row?.stateEnteredAt.getTime()).toBeGreaterThan(waitedSince.getTime())
			})
			const [waiting] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
			expect(waiting?.status).toBe('queued')
			expect(waiting?.completedAt).toBeNull()

			// The slot frees; the next pass hands the helper to the dispatch queue.
			await db
				.update(sessions)
				.set({ status: 'completed', sessionState: 'done', completedAt: new Date() })
				.where(eq(sessions.id, blocker.id))
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect(row?.status).toBe('starting')
		expect(row?.sessionState).toBe('waiting_for_machine')
	})
})
