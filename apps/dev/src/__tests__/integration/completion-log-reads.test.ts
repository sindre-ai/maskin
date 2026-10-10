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
 * Completing a remote session used to read the session's newest 50 stdout log
 * rows twice, back to back: once to parse usage and once for the failure
 * classifier. At ~4.6 KB a row that was ~40% of database egress. These pin that
 * it is one read now and that both consumers still get what they need from it.
 */

const RESULT_LINE =
	'{"type":"result","subtype":"success","total_cost_usd":0.5,"usage":{"input_tokens":120,"output_tokens":45},"duration_ms":900}\n'
const LIMIT_TAIL =
	'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788532200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}\n' +
	"You've hit your limit · resets 2:30pm (UTC)\n"

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

describe('remote session completion — log reads', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		actorId = actor.id
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	/** Completes a session through a db that records every statement it issues. */
	async function complete(
		exitCode: number,
		logs: string[],
		opts: { stoppedByUser?: boolean } = {},
	) {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			containerId: 'sandbox-under-test',
		})
		for (const content of logs) {
			await insertSessionLog(db, session.id, { stream: 'stdout', content })
		}

		const captured: string[] = []
		const loggedDb = drizzle(sql, {
			schema: { sessions, sessionLogs },
			logger: { logQuery: (query) => captured.push(query) },
		}) as unknown as Database

		const manager = new SessionManager(loggedDb, stubStorage())
		configureSessionLifecycle({ db: loggedDb, sessionManager: manager })
		vi.spyOn(manager, 'startSession').mockResolvedValue(undefined)
		try {
			await manager.markRemoteSessionComplete(session.id, exitCode, opts)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		return { row, captured }
	}

	const contentReads = (queries: string[]) =>
		queries.filter((q) => q.startsWith('select "content" from "session_logs"'))

	it('reads the stdout tail from session_logs exactly once', async () => {
		const { captured } = await complete(0, [RESULT_LINE])

		expect(contentReads(captured)).toHaveLength(1)
	})

	it('still records usage parsed from that single read', async () => {
		const { row } = await complete(0, ['{"type":"system"}\n', RESULT_LINE])

		expect(row?.status).toBe('completed')
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.5)
		expect(row?.inputTokens).toBe(120)
		expect(row?.outputTokens).toBe(45)
	})

	it('still classifies a usage-limit banner from that single read', async () => {
		const { row, captured } = await complete(1, [LIMIT_TAIL])

		expect(row?.status).toBe('failed')
		expect(row?.result).toMatchObject({
			failure_reason: { provider: 'anthropic', reason_code: 'session_limit' },
		})
		expect(contentReads(captured)).toHaveLength(1)
	})

	it('does not classify the tail for a user-initiated stop, but still takes usage', async () => {
		const { row } = await complete(1, [LIMIT_TAIL, RESULT_LINE], { stoppedByUser: true })

		expect(row?.result).not.toHaveProperty('failure_reason')
		expect(Number(row?.totalCostUsd)).toBeCloseTo(0.5)
	})
})

describe('hasOtherActiveSessions index', () => {
	it('has a valid (actor_id, status) index the lookup can use', async () => {
		const [index] = await sql`
			SELECT i.indisvalid AS valid
			FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
			WHERE c.relname = 'sessions_actor_status_idx'`
		expect(index?.valid).toBe(true)

		const captured: Array<{ query: string; params: unknown[] }> = []
		const loggedDb = drizzle(sql, {
			schema: { sessions },
			logger: { logQuery: (query, params) => captured.push({ query, params }) },
		}) as unknown as Database
		const manager = new SessionManager(loggedDb, stubStorage())
		try {
			await (
				manager as unknown as {
					hasOtherActiveSessions: (actor: string, exclude: string) => Promise<boolean>
				}
			).hasOtherActiveSessions(
				'11111111-1111-4111-8111-111111111111',
				'22222222-2222-4222-8222-222222222222',
			)
		} finally {
			await manager.stop()
		}

		const issued = captured.find((c) => c.query.includes('"actor_id" ='))
		if (!issued) throw new Error('lookup was not issued')
		const plan = await sql.begin(async (tx) => {
			await tx.unsafe('SET LOCAL enable_seqscan = off')
			return JSON.stringify(
				await tx.unsafe(`EXPLAIN (FORMAT JSON) ${issued.query}`, issued.params as never[]),
			)
		})

		expect(plan).toContain('sessions_actor_status_idx')
	})
})
