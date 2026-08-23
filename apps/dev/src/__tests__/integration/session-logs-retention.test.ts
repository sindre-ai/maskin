import { sessionLogs } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * Log retention, against real Postgres.
 *
 * The exemption is the whole point: an interactive session's logs are the
 * activity trace rendered under each chat message, so pruning them guts the
 * history of conversations the user can still open and read. A mocked DB
 * cannot verify the candidate-selection SQL that encodes that.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const ANCIENT = new Date(Date.now() - 60 * DAY_MS)
const RECENT = new Date(Date.now() - 1 * DAY_MS)

describe('Session log retention', () => {
	let workspaceId: string
	let actorId: string
	let manager: SessionManager

	async function seed(
		sessionOverrides: Record<string, unknown>,
		logCreatedAt: Date,
	): Promise<string> {
		const session = await insertSession(db, workspaceId, actorId, actorId, sessionOverrides)
		if (!session) throw new Error('failed to seed session')
		await db
			.insert(sessionLogs)
			.values({ sessionId: session.id, stream: 'stdout', content: 'x', createdAt: logCreatedAt })
		return session.id
	}

	async function logCount(sessionId: string) {
		const rows = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId))
		return rows.length
	}

	/** Reaches the private sweep directly — the watchdog also does timeouts and pausing. */
	async function prune() {
		await (manager as unknown as { pruneSessionLogs: () => Promise<void> }).pruneSessionLogs()
	}

	beforeEach(async () => {
		const actor = await insertActor(db, { type: 'agent' })
		if (!actor) throw new Error('failed to seed actor')
		actorId = actor.id
		const workspace = await insertWorkspace(db, actorId)
		if (!workspace) throw new Error('failed to seed workspace')
		workspaceId = workspace.id

		manager = new SessionManager(db, {} as StorageProvider)
	})

	it('never prunes an interactive session, however old', async () => {
		const chat = await seed(
			{ interactive: true, status: 'completed', completedAt: ANCIENT },
			ANCIENT,
		)
		await prune()
		expect(await logCount(chat)).toBe(1)
	})

	it('prunes an old completed non-interactive session', async () => {
		const batch = await seed(
			{ interactive: false, status: 'completed', completedAt: ANCIENT },
			ANCIENT,
		)
		await prune()
		expect(await logCount(batch)).toBe(0)
	})

	it('keeps recent logs of an old non-interactive session', async () => {
		const batch = await seed(
			{ interactive: false, status: 'completed', completedAt: ANCIENT },
			RECENT,
		)
		await prune()
		expect(await logCount(batch)).toBe(1)
	})

	it('leaves a still-running non-interactive session alone', async () => {
		const running = await seed(
			{ interactive: false, status: 'running', completedAt: null },
			ANCIENT,
		)
		await prune()
		expect(await logCount(running)).toBe(1)
	})

	it('is throttled — a second immediate sweep is a no-op', async () => {
		const first = await seed(
			{ interactive: false, status: 'completed', completedAt: ANCIENT },
			ANCIENT,
		)
		await prune()
		expect(await logCount(first)).toBe(0)

		// The sweep used to run on every 60s watchdog tick as an unbounded
		// table-wide DELETE. It is hourly now; a second call inside the window
		// must not touch the DB again.
		const second = await seed(
			{ interactive: false, status: 'completed', completedAt: ANCIENT },
			ANCIENT,
		)
		await prune()
		expect(await logCount(second)).toBe(1)
	})
})
