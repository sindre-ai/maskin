import type { Database } from '@maskin/db'
import { events, sessionLogs, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { vi } from 'vitest'
import { SessionManager } from '../../services/session-manager'
import {
	SELF_HEAL_DEFAULT_LIMIT,
	SELF_HEAL_GRACE_MS,
	SELF_HEAL_LOOKBACK_MS,
	SELF_HEAL_RECENT_LOOKBACK_MS,
	SessionReconciler,
} from '../../services/session-reconciler'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => undefined),
}))

/**
 * The two background sweeps that were scanning the whole `sessions` table every
 * pass (mean 4.6s and 9.0s, max 113s) and evicting the buffer cache with it.
 * Both are now bounded to a window; these tests pin what is and is not inside
 * it, because a window silently excluding rows it should reach would look like a
 * working system until the backlog shows up.
 */

const DAY_MS = 24 * 60 * 60 * 1000

async function explainWithIndexes(query: string, params: unknown[]): Promise<string> {
	return sql.begin(async (tx) => {
		await tx.unsafe('SET LOCAL enable_seqscan = off')
		const rows = await tx.unsafe(`EXPLAIN (FORMAT JSON) ${query}`, params as never[])
		return JSON.stringify(rows)
	})
}

describe('SessionReconciler.selfHealTerminalWithoutEvents window', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('failed to seed workspace')
		workspaceId = ws.id
	})

	const completedAgo = (ms: number) =>
		insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			completedAt: new Date(Date.now() - ms),
		})

	it('back-fills a recently settled session that has no events row', async () => {
		const session = await completedAgo(5 * 60_000)

		const result = await new SessionReconciler(db).selfHealTerminalWithoutEvents()

		expect(result.backFilled).toContainEqual({
			sessionId: session?.id,
			action: 'session_completed',
		})
	})

	it('does not reach back past the lookback window', async () => {
		const stale = await completedAgo(SELF_HEAL_LOOKBACK_MS + DAY_MS)

		const result = await new SessionReconciler(db).selfHealTerminalWithoutEvents()

		expect(result.backFilled.map((b) => b.sessionId)).not.toContain(stale?.id)
	})

	it('the short per-tick window skips a session settled before it, the full window reaches it', async () => {
		const older = await completedAgo(SELF_HEAL_RECENT_LOOKBACK_MS + 60 * 60_000)
		const reconciler = new SessionReconciler(db)

		const recent = await reconciler.selfHealTerminalWithoutEvents(
			Date.now(),
			SELF_HEAL_GRACE_MS,
			SELF_HEAL_DEFAULT_LIMIT,
			SELF_HEAL_RECENT_LOOKBACK_MS,
		)
		expect(recent.backFilled.map((b) => b.sessionId)).not.toContain(older?.id)

		const full = await reconciler.selfHealTerminalWithoutEvents()
		expect(full.backFilled.map((b) => b.sessionId)).toContain(older?.id)
	})

	it('leaves a session alone when its events row exists in the same workspace', async () => {
		const session = await completedAgo(5 * 60_000)
		await db.insert(events).values({
			workspaceId,
			actorId,
			action: 'session_completed',
			entityType: 'session',
			entityId: session?.id as string,
		})

		const result = await new SessionReconciler(db).selfHealTerminalWithoutEvents()

		expect(result.backFilled.map((b) => b.sessionId)).not.toContain(session?.id)
	})

	it('has a valid settled-at index', async () => {
		const [index] = await sql`
			SELECT i.indisvalid AS valid
			FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			WHERE c.relname = 'sessions_settled_at_idx'`
		expect(index?.valid).toBe(true)
	})

	it('issues SQL that the settled-at index and the session events index can serve', async () => {
		await completedAgo(5 * 60_000)
		const captured: Array<{ query: string; params: unknown[] }> = []
		const loggedDb = drizzle(sql, {
			schema: { sessions, events },
			logger: { logQuery: (query, params) => captured.push({ query, params }) },
		}) as unknown as Database

		await new SessionReconciler(loggedDb).selfHealTerminalWithoutEvents()

		const issued = captured.find((c) => c.query.includes('not exists'))
		if (!issued) throw new Error('self-heal query was not issued')
		// Without the workspace equality the events probe cannot use its index's
		// leading column and walks the whole index per session.
		expect(issued.query).toContain('"events"."workspace_id" = "sessions"."workspace_id"')
		const plan = await explainWithIndexes(issued.query, issued.params)

		expect(plan).toContain('sessions_settled_at_idx')
		// On an empty test table the planner cannot rank the two events indexes (no
		// statistics, no visibility map), so a bare EXPLAIN says nothing about which it
		// prefers. What this pins is that the probe CAN be answered by the partial session
		// index (migration 0114): with the older workspace index dropped inside a
		// transaction that is rolled back, it is the only index left to serve it.
		const rolledBack = new Error('rollback')
		let probePlan = ''
		await sql
			.begin(async (tx) => {
				await tx.unsafe('DROP INDEX events_ws_entity_id_idx')
				await tx.unsafe('SET LOCAL enable_seqscan = off')
				const rows = await tx.unsafe(
					`EXPLAIN (FORMAT JSON) ${issued.query}`,
					issued.params as never[],
				)
				probePlan = JSON.stringify(rows)
				throw rolledBack
			})
			.catch((err) => {
				if (err !== rolledBack) throw err
			})
		expect(probePlan).toContain('events_session_entity_action_idx')
	})

	it('has a valid session events probe index', async () => {
		const [index] = await sql`
			SELECT i.indisvalid AS valid
			FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			WHERE c.relname = 'events_session_entity_action_idx'`
		expect(index?.valid).toBe(true)
	})
})

describe('session log retention window', () => {
	let workspaceId: string
	let actorId: string
	let manager: SessionManager

	async function seed(completedAgoMs: number): Promise<string> {
		const completedAt = new Date(Date.now() - completedAgoMs)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			interactive: false,
			status: 'completed',
			completedAt,
		})
		if (!session) throw new Error('failed to seed session')
		await db
			.insert(sessionLogs)
			.values({ sessionId: session.id, stream: 'stdout', content: 'x', createdAt: completedAt })
		return session.id
	}

	async function logCount(sessionId: string) {
		const rows = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, sessionId))
		return rows.length
	}

	/** Runs one sweep, bypassing the hourly throttle. */
	async function prune() {
		const internals = manager as unknown as {
			lastLogPruneAt: number
			pruneSessionLogs: () => Promise<void>
		}
		internals.lastLogPruneAt = 0
		await internals.pruneSessionLogs()
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

	it('drains a backlog older than the window on the first sweep after boot', async () => {
		const ancient = await seed(120 * DAY_MS)

		await prune()

		expect(await logCount(ancient)).toBe(0)
	})

	it('once drained, still prunes sessions that cross the retention cutoff', async () => {
		await prune() // nothing to do: marks the backlog drained
		const justPastCutoff = await seed(31 * DAY_MS)

		await prune()

		expect(await logCount(justPastCutoff)).toBe(0)
	})

	it('once drained, stops looking beyond the window instead of rescanning old sessions', async () => {
		await prune()
		const beyondWindow = await seed(120 * DAY_MS)

		await prune()

		// The documented trade-off: after the first sweep, only [cutoff - 14d, cutoff)
		// is scanned, so a session this old that appeared since is left alone.
		expect(await logCount(beyondWindow)).toBe(1)
	})
})
