import type { Database } from '@maskin/db'
import { sessionLogs, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { vi } from 'vitest'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

/**
 * The watchdog's idle-pause step asks, for every running non-interactive
 * session on every tick, "when was the last log line written?". It only needs
 * the timestamp, but a bare `.select()` fetched the whole newest row including
 * its `content` (~4.6 KB), which across a few hundred thousand calls was a
 * visible slice of database egress. These pin that only the timestamp travels.
 */

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

describe('watchdog idle-pause last-log read', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		actorId = actor.id
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function tick(loggedDb: Database) {
		const manager = new SessionManager(loggedDb, stubStorage())
		configureSessionLifecycle({ db: loggedDb, sessionManager: manager })
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		try {
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}
	}

	function loggedDatabase(captured: string[]): Database {
		return drizzle(sql, {
			schema: { sessions, sessionLogs },
			logger: { logQuery: (query) => captured.push(query) },
		}) as unknown as Database
	}

	it('selects only created_at when looking up a running session’s last log line', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			interactive: false,
			containerId: 'container-under-test',
			startedAt: new Date(),
		})
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: 'x'.repeat(4096),
			createdAt: new Date(),
		})

		const captured: string[] = []
		await tick(loggedDatabase(captured))

		const lastLogReads = captured.filter(
			(q) =>
				q.includes('from "session_logs"') &&
				q.includes('order by "session_logs"."created_at" desc'),
		)
		expect(lastLogReads.length).toBeGreaterThan(0)
		for (const query of lastLogReads) {
			expect(query).not.toContain('"content"')
			expect(query.startsWith('select "created_at" from "session_logs"')).toBe(true)
		}
	})

	it('still leaves a recently active session running', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			interactive: false,
			containerId: 'container-under-test',
			startedAt: new Date(),
		})
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: 'alive',
			createdAt: new Date(),
		})

		await tick(loggedDatabase([]))

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
	})
})
