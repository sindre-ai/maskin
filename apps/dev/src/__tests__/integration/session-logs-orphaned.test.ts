import { sessionLogs, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		listWithMetadata: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// Regression coverage for Sentry MASKIN-DEV-5 / MASKIN-AGENT-SERVER-1. A remote
// session's sandbox keeps streaming logs for the rest of its life, but the
// `sessions` row can be hard-deleted underneath it (deleting an actor,
// uninstalling a loop, or a loop version push all `delete(sessions)` by
// actorId). Every subsequent log insert then violates
// session_logs_session_id_sessions_id_fk. The log-ingest route depends on that
// failure surfacing as SQLSTATE 23503 on the error's `cause` so it can answer a
// terminal 410 instead of a retryable 500 — a mocked-DB test can't verify the
// SQLSTATE, so this asserts it against real Postgres.
describe('session_logs foreign key on a deleted session (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('deletes a session row and its logs together', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await db.insert(sessionLogs).values({
			sessionId: session.id,
			stream: 'stdout',
			content: 'a line written while the session still existed',
		})

		await db.delete(sessions).where(eq(sessions.id, session.id))

		const remaining = await db
			.select()
			.from(sessionLogs)
			.where(eq(sessionLogs.sessionId, session.id))
		expect(remaining).toHaveLength(0)
	})

	it('rejects a log append for a deleted session with SQLSTATE 23503', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId)
		await db.delete(sessions).where(eq(sessions.id, session.id))

		const manager = new SessionManager(db, stubStorage())
		let caught: unknown
		try {
			await manager.appendRemoteSessionLogs(session.id, [
				{ stream: 'stdout', content: 'a line from an orphaned sandbox' },
			])
		} catch (err) {
			caught = err
		}

		expect(caught).toBeInstanceOf(Error)
		const cause = (caught as Error).cause as { code?: string } | undefined
		expect(cause?.code).toBe('23503')
	})
})
