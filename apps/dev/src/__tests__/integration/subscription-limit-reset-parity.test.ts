import { events, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import {
	MAX_RETRY_ATTEMPTS,
	SessionRetryScheduler,
} from '../../services/session-retry-scheduler'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * §7.9 / §21.2 — three parity cells on real Postgres that pin the end-to-end
 * wiring of the reset-at parser + settleSession + retry-scheduler:
 *
 *   (a) parseable reset → retry_at is stamped on the terminal row + failure_reason
 *       carries reset_source / reset_confidence.
 *   (b) attempt_number at the cap → scheduler tick emits session_retry_capped,
 *       clears retry_at, does NOT fire a retry session.
 *   (c) no parseable reset → row sits terminal-failed with retry_at null.
 *
 * Load-bearing because unit-mocked cells can't prove the DB write shape — a
 * schema regression on failure_reason (reset_source / reset_confidence
 * additions in this bet) would pass with a fake DB and fail on Postgres.
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

// A well-shaped CLI banner tail: session-limit banner + a Resets fragment
// naming a UTC absolute time. `parseCliResetBanner` clamps to [now+60s, now+24h],
// so pick an hour-of-day that's well inside the coming 24h and past the +60s floor.
// Using a UTC absolute time (not a delta) makes the assertion robust to when the
// test runs — the banner resolves against real Date.now(), then anchors that same
// hour-of-day today or tomorrow.
const BANNER_WITH_RESET = "You've hit your limit — resets 11:30am (UTC)\n"
const BANNER_WITHOUT_RESET = "You've hit your limit — please try again shortly\n"

describe('subscription-limit reset-at parity cells (§7.9)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('(a) parseable reset → settleSession stamps retry_at + failure_reason.reset_source/confidence', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			config: { llm_route: 'claude_oauth' },
			attemptNumber: 1,
		})
		await insertSessionLog(db, session.id, { stream: 'stdout', content: BANNER_WITH_RESET })

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 1)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		// The CLI banner path is source=cli-banner + confidence=advisory (only
		// classifier that reaches settleSession today; failover-side sources
		// land on a different path per §17.5).
		const failure = (row?.result as { failure_reason?: Record<string, unknown> } | null)
			?.failure_reason
		expect(failure?.reason_code).toBe('session_limit')
		expect(failure?.reset_source).toBe('cli-banner')
		expect(failure?.reset_confidence).toBe('advisory')
		// retry_at is set — the scheduler's partial index (WHERE retry_at IS
		// NOT NULL AND retried_session_id IS NULL) now sees this row.
		expect(row?.retryAt).not.toBeNull()
		expect((row?.retryAt as Date).getTime()).toBeGreaterThan(Date.now())
	})

	it('(b) attempt_number at cap → scheduler tick emits session_retry_capped, no retry fires', async () => {
		const nowMs = Date.now()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'failed',
			attemptNumber: MAX_RETRY_ATTEMPTS,
			retryAt: new Date(nowMs - 60_000),
		})

		const scheduler = new SessionRetryScheduler(db, {} as NodeJS.ProcessEnv)
		await scheduler.tick(new Date(nowMs))

		// retry_at cleared by the cap-clear path — the partial index no longer
		// sees this row so it won't be re-visited every tick.
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.retryAt).toBeNull()
		expect(row?.retriedSessionId).toBeNull()

		// A session_retry_capped audit event landed for this session, carrying
		// the cap constant so operators can trace which cap governed the stop.
		const cappedEvents = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, session.id), eq(events.action, 'session_retry_capped')))
		expect(cappedEvents.length).toBe(1)
		const data = cappedEvents[0]?.data as Record<string, unknown> | null
		expect(data?.cap).toBe(MAX_RETRY_ATTEMPTS)
	})

	it('(c) no parseable reset → row sits terminal-failed with retry_at null', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			config: { llm_route: 'claude_oauth' },
			attemptNumber: 1,
		})
		await insertSessionLog(db, session.id, { stream: 'stdout', content: BANNER_WITHOUT_RESET })

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 1)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		// Classifier still stamped a failure_reason (session_limit banner
		// matched), but with reset_at null there's no retry to schedule and
		// reset_source / reset_confidence must be absent (they only land when
		// the parser produced a value).
		const failure = (row?.result as { failure_reason?: Record<string, unknown> } | null)
			?.failure_reason
		expect(failure?.reason_code).toBe('session_limit')
		expect(failure?.reset_at).toBeNull()
		expect(failure?.reset_source).toBeUndefined()
		expect(failure?.reset_confidence).toBeUndefined()
		expect(row?.retryAt).toBeNull()
	})
})
