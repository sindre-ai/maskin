import { events, agentServers, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import type { SessionDispatchQueue } from '../../services/session-dispatch-queue'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// A session on an agent-server can be paused and resumed. Pausing stops the sandbox;
// the agent-server saves the /agent folder to storage as the sandbox ends and then
// reports completion, and that report settles the row as paused. Resuming puts the
// row back in the dispatch queue; the agent-server restores the folder from storage
// under the same session id. These run against real Postgres because the settle is a
// compare-and-set under an advisory lock, which the mock DB cannot model.

// The key the agent-server writes the folder to (apps/agent-server session-workspace.ts).
const archiveKey = (sessionId: string) => `session-workspaces/${sessionId}.tar.gz`

// Storage whose archive appears when the test says the agent-server has uploaded it.
function archiveStorage() {
	const present = new Set<string>()
	const storage: StorageProvider = {
		put: async (key) => {
			present.add(key)
		},
		get: async () => Buffer.from(''),
		list: async () => [],
		listWithMetadata: async () => [],
		delete: async (key) => {
			present.delete(key)
		},
		exists: async (key) => present.has(key),
		ensureBucket: async () => {},
	} as unknown as StorageProvider
	return { storage, present }
}

async function insertAgentServer() {
	const [row] = await db
		.insert(agentServers)
		.values({
			url: 'https://agent-under-test.maskin.test:3001',
			secret: 'x'.repeat(32),
			maxConcurrentSessions: 10,
			status: 'active',
		})
		.returning()
	return row
}

// Shorten the wait so a pause that never gets its report finishes inside a test.
function shortenPauseWait(manager: SessionManager, waitMs: number) {
	const tunable = manager as unknown as { remotePauseWaitMs: number; remotePausePollMs: number }
	tunable.remotePauseWaitMs = waitMs
	tunable.remotePausePollMs = 10
}

describe('Remote session pause and resume (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
	})

	it('pauses on the agent-server report: stops the sandbox, keeps the archive key, frees the container', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-under-test',
		})
		const { storage, present } = archiveStorage()
		const manager = new SessionManager(db, storage)
		shortenPauseWait(manager, 5_000)

		const stopBodies: unknown[] = []
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			expect(String(input)).toBe(`${server.url}/sessions/${session.id}/stop`)
			stopBodies.push(JSON.parse(String(init?.body)))
			// What the agent-server does next: save the folder, then report completion
			// with the exit code of a sandbox that was stopped on purpose.
			setTimeout(() => {
				present.add(archiveKey(session.id))
				void manager.markRemoteSessionComplete(session.id, 137)
			}, 30)
			return new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		})

		try {
			await manager.pauseSession(session.id)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		expect(stopBodies).toEqual([{ reason: 'pause', source: 'user-stop' }])

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('paused')
		expect(row?.snapshotPath).toBe(archiveKey(session.id))
		expect(row?.containerId).toBeNull()
		// A paused row is on hold, not complete.
		expect(row?.completedAt).toBeNull()

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.filter((e) => e.action === 'session_paused')).toHaveLength(1)
		// The exit code of the stopped sandbox is not a failure.
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
	})

	it('pauses from the archive alone when the agent-server never reports', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-no-report',
		})
		const { storage, present } = archiveStorage()
		const manager = new SessionManager(db, storage)
		shortenPauseWait(manager, 5_000)

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			// The upload lands, the report never does (the agent-server restarted).
			setTimeout(() => present.add(archiveKey(session.id)), 30)
			return new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), { status: 200 })
		})

		try {
			await manager.pauseSession(session.id)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('paused')
		expect(row?.snapshotPath).toBe(archiveKey(session.id))
	})

	it('settles once when the report and the wait loop both finish the pause', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-race',
		})
		const { storage, present } = archiveStorage()
		const manager = new SessionManager(db, storage)
		shortenPauseWait(manager, 5_000)

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			// The archive is there and the report arrives at the same moment the wait
			// loop sees the archive: both try to settle.
			present.add(archiveKey(session.id))
			void manager.markRemoteSessionComplete(session.id, 137)
			return new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), { status: 200 })
		})

		try {
			await manager.pauseSession(session.id)
			// A late duplicate report finds the row paused and changes nothing.
			await expect(manager.markRemoteSessionComplete(session.id, 137)).resolves.toBe(true)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('paused')
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.filter((e) => e.action === 'session_paused')).toHaveLength(1)
	})

	it('fails the session when the workspace never reaches storage, since it could not be resumed', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-lost-workspace',
		})
		const { storage } = archiveStorage()
		const manager = new SessionManager(db, storage)
		shortenPauseWait(manager, 200)

		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), { status: 200 }),
			)

		try {
			await manager.pauseSession(session.id)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(row?.snapshotPath).toBeNull()
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_paused')).toBe(false)
	})

	it('puts the session back to running when the agent-server cannot stop the sandbox', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-unreachable',
		})
		const { storage } = archiveStorage()
		const manager = new SessionManager(db, storage)
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('boom', { status: 500 }))

		try {
			await expect(manager.pauseSession(session.id)).rejects.toThrow(
				'agent-server returned HTTP 500',
			)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
		expect(row?.containerId).toBe('sandbox-unreachable')
	})

	it('a second pause while the first is in flight does not stop the sandbox twice', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-double-click',
		})
		const { storage, present } = archiveStorage()
		const manager = new SessionManager(db, storage)
		shortenPauseWait(manager, 5_000)

		let stops = 0
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			stops += 1
			setTimeout(() => {
				present.add(archiveKey(session.id))
				void manager.markRemoteSessionComplete(session.id, 137)
			}, 50)
			return new Response(JSON.stringify({ stopped: 'sandbox-stopped' }), { status: 200 })
		})

		try {
			const results = await Promise.allSettled([
				manager.pauseSession(session.id),
				manager.pauseSession(session.id),
			])
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
			expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		expect(stops).toBe(1)
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('paused')
	})

	it('resumes a paused remote session by queueing it for dispatch on any agent-server', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'paused',
			agentServerId: server.id,
			containerId: null,
			snapshotPath: archiveKey('placeholder'),
		})
		const { storage } = archiveStorage()
		const manager = new SessionManager(db, storage)
		const enqueued: string[] = []
		manager.setDispatchQueue({
			enqueue: async (sessionId: string) => {
				enqueued.push(sessionId)
			},
		} as unknown as SessionDispatchQueue)

		try {
			await manager.resumeSession(session.id)
		} finally {
			await manager.stop()
		}

		// Handed to the dispatch queue like a new session, which picks the server.
		expect(enqueued).toEqual([session.id])
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('starting')
		// The old server pin is dropped: the workspace is in storage, any server can restore it.
		expect(row?.agentServerId).toBeNull()
		expect(row?.snapshotPath).toBeNull()
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.filter((e) => e.action === 'session_resumed')).toHaveLength(1)
	})

	it('a second resume while the first is in flight queues the session once', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'paused',
			agentServerId: server.id,
			containerId: null,
			snapshotPath: archiveKey('placeholder'),
		})
		const { storage } = archiveStorage()
		const manager = new SessionManager(db, storage)
		const enqueued: string[] = []
		manager.setDispatchQueue({
			enqueue: async (sessionId: string) => {
				enqueued.push(sessionId)
			},
		} as unknown as SessionDispatchQueue)

		try {
			const results = await Promise.allSettled([
				manager.resumeSession(session.id),
				manager.resumeSession(session.id),
			])
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		} finally {
			await manager.stop()
		}

		expect(enqueued).toHaveLength(1)
	})
})
