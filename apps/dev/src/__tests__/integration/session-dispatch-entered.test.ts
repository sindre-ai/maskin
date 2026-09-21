import { events, sessions, workspaces } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertWorkspace } from '../factories'
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

async function dispatchEnteredEventsFor(sessionId: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.entityId, sessionId), eq(events.action, 'dispatch_entered')))
}

// A session stalled in `starting` is ambiguous: either dispatch was entered and
// blocked downstream, or it was never dispatched at all. The `dispatch_entered`
// row disambiguates. It must be unconditional — emitted before the capacity
// check, the queue handoff and any lock — so a session that takes an early-return
// branch still records that its dispatch ran. See startSession() in session-manager.ts.
describe('SessionManager.startSession — dispatch_entered audit event (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('emits a dispatch_entered session event for a dispatched session', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			containerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			// No real agent/Docker path exists in this harness — the launch is
			// expected to fail past the entry marker. The marker is the assertion.
			await manager.startSession(session.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		const rows = await dispatchEnteredEventsFor(session.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.entityType).toBe('session')
		expect(rows[0]?.workspaceId).toBe(workspaceId)
		expect(rows[0]?.actorId).toBe(actorId)
		expect(rows[0]?.data).toEqual({})
	})

	it('emits the event even when the session is queued instead of dispatched', async () => {
		// Fill the workspace cap so startSession takes its early-return queue
		// branch — the branch that never reaches the dispatch call itself.
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		await db
			.update(workspaces)
			.set({ settings: { ...(ws?.settings ?? {}), max_concurrent_sessions: 1 } })
			.where(eq(workspaces.id, workspaceId))

		await insertSession(db, workspaceId, actorId, actorId, { status: 'running' })
		const pending = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			containerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.startSession(pending.id)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
		expect(row?.status).toBe('queued')

		// The marker fired before the capacity check, so it is present despite
		// the session never reaching the dispatch call.
		const rows = await dispatchEnteredEventsFor(pending.id)
		expect(rows).toHaveLength(1)
	})
})
