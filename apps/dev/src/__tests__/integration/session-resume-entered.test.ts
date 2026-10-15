import { events } from '@maskin/db/schema'
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

async function eventsFor(sessionId: string, action: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.entityId, sessionId), eq(events.action, action)))
}

// A session stalled in `starting` is ambiguous across two origins: startSession
// and resumeSession both write that status. The `dispatch_entered` marker only
// covers the start path; the resume path needs its own `resume_entered` marker,
// emitted before the `starting` transition and before any lock, so a resume that
// stalls mid-path still records that the path was entered. See resumeSession()
// in session-manager.ts.
describe('SessionManager.resumeSession — resume_entered audit event (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('emits a resume_entered session event for a resumed session', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'paused',
			containerId: null,
			snapshotPath: 'snapshots/test-session.tar',
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			// No real snapshot/Docker path exists in this harness — the resume is
			// expected to fail past the entry marker. The marker is the assertion.
			await manager.resumeSession(session.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		const rows = await eventsFor(session.id, 'resume_entered')
		expect(rows).toHaveLength(1)
		expect(rows[0]?.entityType).toBe('session')
		expect(rows[0]?.workspaceId).toBe(workspaceId)
		expect(rows[0]?.actorId).toBe(actorId)
		expect(rows[0]?.data).toEqual({})
	})

	it('records the resume origin, not the dispatch origin, for a resume-entry stall', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'paused',
			containerId: null,
			snapshotPath: 'snapshots/test-session.tar',
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.resumeSession(session.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		// The discriminator stays exclusive: a row entered via the resume path
		// carries `resume_entered` and no `dispatch_entered`, so "neither marker
		// present" keeps meaning dispatch never ran.
		expect(await eventsFor(session.id, 'resume_entered')).toHaveLength(1)
		expect(await eventsFor(session.id, 'dispatch_entered')).toHaveLength(0)
	})
})
