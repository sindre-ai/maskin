import { events, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { captureLiveSessions, stopSessionsForActors } from '../../services/session-cleanup'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function stubSessionManager(stopSession: (id: string) => Promise<void>): SessionManager {
	return { stopSession } as unknown as SessionManager
}

// Stop-before-delete coverage. Deleting an agent cascades to its session rows,
// but the sandbox on the agent-server keeps running: it holds a capacity slot
// until the 2h timeout, keeps acting as an agent the user believes is gone, and
// streams logs at a session_id that no longer exists (Sentry MASKIN-DEV-5 /
// MASKIN-AGENT-SERVER-1). Status filtering is the load-bearing part — stopping
// an already-finished session would be wrong — so it's asserted against real
// Postgres rather than a mocked query builder.
describe('stopSessionsForActors (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('stops only the live sessions of the given actors', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const other = await insertActor(db, { type: 'agent' })

		const running = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'running',
		})
		const queued = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'queued',
		})
		const finished = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'completed',
		})
		const otherAgents = await insertSession(db, workspaceId, other.id, actorId, {
			status: 'running',
		})

		const stopped: string[] = []
		const result = await stopSessionsForActors(
			db,
			stubSessionManager(async (id) => {
				stopped.push(id)
			}),
			[agent.id],
		)

		expect(stopped.sort()).toEqual([running.id, queued.id].sort())
		expect(stopped).not.toContain(finished.id)
		expect(stopped).not.toContain(otherAgents.id)
		expect(result.failed).toEqual([])
	})

	it('reports a failed stop without throwing, so the delete can still proceed', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const session = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'running',
		})

		const result = await stopSessionsForActors(
			db,
			stubSessionManager(async () => {
				throw new Error('agent-server unreachable')
			}),
			[agent.id],
		)

		expect(result.failed).toEqual([session.id])
		expect(result.stopped).toEqual([])
	})

	it('records an audit event that outlives the deleted session row', async () => {
		// The session row is deleted moments later, so a `failure_reason` on it
		// would never be seen — the events feed is the only surface left.
		const agent = await insertActor(db, { type: 'agent' })
		const session = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'running',
		})

		await stopSessionsForActors(
			db,
			stubSessionManager(async () => {}),
			[agent.id],
		)
		await db.delete(sessions).where(eq(sessions.id, session.id))

		const recorded = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.action).toBe('session_failed')
		const data = recorded[0]?.data as {
			source: string
			failure_reason: { reason_code: string }
		}
		expect(data.source).toBe('agent_deleted')
		expect(data.failure_reason.reason_code).toBe('agent_deleted')
	})

	it('is a no-op when the actors have no live sessions', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		await insertSession(db, workspaceId, agent.id, actorId, { status: 'failed' })

		const stopSession = async () => {
			throw new Error('should not be called')
		}
		const result = await stopSessionsForActors(db, stubSessionManager(stopSession), [agent.id])

		expect(result).toEqual({ stopped: [], failed: [] })
	})
})

describe('captureLiveSessions (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('captures live rows with the agent-server needed to stop them post-delete', async () => {
		// The uninstall/version-push callers only learn which actors survive
		// inside their transaction, so they capture first and stop after commit.
		// The capture must carry agentServerId — once the row is gone,
		// SessionManager.stopSession can no longer look it up.
		const agent = await insertActor(db, { type: 'agent' })
		const running = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'running',
		})
		await insertSession(db, workspaceId, agent.id, actorId, { status: 'completed' })

		const captured = await captureLiveSessions(db, [agent.id])

		expect(captured).toHaveLength(1)
		expect(captured[0]?.id).toBe(running.id)
		expect(captured[0]).toHaveProperty('agentServerId')
	})
})
