// The §5.2 parity matrix — real-Postgres cells for the DB-semantic columns.
//
// The mocked-DB parity file at apps/dev/src/services/session-lifecycle.parity.test.ts
// pins the `SettleResult` shape returned by `settleSession()` (cols 4, 6, 8:
// stopSandbox routing, pushAgentFiles, PostHog dual-emit). This file drives the
// SAME 10 rows against a real Postgres database and asserts on what actually
// lands on the `sessions` and `events` tables — the DB-semantic columns:
//
//   col 1 — sessions.status = mapped terminal (§1.2)
//   col 2 — sessions.completed_at set (except pause where null)
//   col 3 — sessions.usage incremented additively via COALESCE(col, 0) + delta
//   col 7 — events row of correct type per §8.2
//
// Load-bearing: the additive-usage contract (§1.4) IS Postgres semantics. A
// unit test with a fake `db.update()` can pass while the real SQL fragment
// silently overwrites (e.g. if the `sql\`COALESCE + delta\`` were replaced
// with a plain literal). Only a real conditional UPDATE against a row with
// pre-existing usage catches that class of regression.

import { events, agentServers, sessions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import type {
	SessionSettleRow,
	SettleDependencies,
	SettleOutcome,
} from '../../services/session-lifecycle'
import { settleSession } from '../../services/session-lifecycle'
import { expectSessionSettled } from '../../services/session-lifecycle.assertions'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

async function insertAgentServer(url = 'https://agent-parity.maskin.test:3001') {
	const [row] = await db
		.insert(agentServers)
		.values({
			url,
			secret: 'x'.repeat(32),
			maxConcurrentSessions: 10,
			status: 'active',
		})
		.returning()
	return row
}

type Host = 'local' | 'remote'
type Kind = SettleOutcome['kind']

const HOSTS: Host[] = ['local', 'remote']
const KINDS: Kind[] = ['complete', 'fail', 'timeout', 'stop', 'pause']

/**
 * Consistent usage delta so the col-3 additive assertion always tests the
 * same shape: pre-existing = 100 in / 200 out, delta = 100 in / 200 out,
 * post = 200 in / 400 out.
 */
const PRIOR_USAGE = { input: 100, output: 200, costUsd: 0.02 }
const DELTA_USAGE = { input: 100, output: 200, costUsd: 0.01 }

function outcomeFor(kind: Kind): SettleOutcome {
	const classification = {
		complete: 'agent_completed',
		fail: 'sandbox_crash',
		timeout: 'wall_timeout',
		stop: 'human_stop',
		pause: 'idle_timeout',
	}[kind] as SettleOutcome['classification']
	const base: SettleOutcome = {
		kind,
		classification,
		source:
			kind === 'stop' ? 'user-stop' : kind === 'timeout' ? 'timeout-watchdog' : 'sandbox-exit',
		usage: {
			inputTokens: DELTA_USAGE.input,
			outputTokens: DELTA_USAGE.output,
			costUsd: DELTA_USAGE.costUsd,
		},
	}
	if (kind === 'pause') return { ...base, snapshotKey: 's3://snapshot/parity' }
	return base
}

function eventActionFor(kind: Kind) {
	return {
		complete: 'session_completed',
		fail: 'session_failed',
		timeout: 'session_timeout',
		stop: 'session_stopped',
		pause: 'session_paused',
	}[kind]
}

function finalStatusFor(kind: Kind) {
	return {
		complete: 'completed',
		fail: 'failed',
		timeout: 'timeout',
		stop: 'user_stopped',
		pause: 'paused',
	}[kind] as SessionSettleRow['status']
}

/**
 * SettleDependencies wiring for the parity harness: stopSandbox reports the
 * host that carried the row (mocked — the real dockerode/agent-server client
 * paths have their own integration tests), pushAgentFiles resolves `ok` (col
 * 6 is asserted in the mocked-DB file). PostHog capture is mocked at the
 * module boundary — a real Postgres pass doesn't need to hit PostHog.
 */
function makeDeps(host: Host): SettleDependencies {
	return {
		db,
		stopSandbox: async () => (host === 'remote' ? 'remote' : 'local'),
		pushAgentFiles: async () => 'ok',
	}
}

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn(async () => undefined),
}))

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

describe('§5.2 parity matrix — DB-semantic cells against real Postgres', () => {
	let workspaceId: string
	let actorId: string
	let remoteAgentServerId: string

	beforeEach(async () => {
		capturePosthogEventMock.mockClear()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
		const server = await insertAgentServer()
		remoteAgentServerId = server.id
	})

	for (const host of HOSTS) {
		for (const kind of KINDS) {
			it(`${host} × ${kind} — status, completed_at, additive usage, events row`, async () => {
				const session = await insertSession(db, workspaceId, actorId, actorId, {
					status: 'running',
					containerId: host === 'local' ? 'sbx-local' : null,
					agentServerId: host === 'remote' ? remoteAgentServerId : null,
					// col 3 — pre-existing usage the settle's delta MUST ADD onto,
					// never overwrite. Any regression that flips the SQL fragment to a
					// plain literal writes DELTA on top of PRIOR here, so the
					// post-settle row would read 100 / 200 instead of 200 / 400.
					inputTokens: PRIOR_USAGE.input,
					outputTokens: PRIOR_USAGE.output,
					totalCostUsd: String(PRIOR_USAGE.costUsd),
					config: { llm_route: 'maskin_plan' },
				})

				const result = await settleSession(session.id, outcomeFor(kind), makeDeps(host))

				const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))

				const expected = {
					finalStatus: finalStatusFor(kind),
					// col 2 — pause deliberately leaves completed_at null; every other
					// terminal kind sets it.
					completedAt: kind === 'pause' ? ('null' as const) : ('set' as const),
					usageDelta: {
						input: DELTA_USAGE.input,
						output: DELTA_USAGE.output,
						costUsd: DELTA_USAGE.costUsd,
					},
					stoppedSandbox: (host === 'remote' ? 'remote' : 'local') as 'remote' | 'local',
					pushedAgentFiles: 'ok' as const,
				}
				const priorUsage = {
					input: PRIOR_USAGE.input,
					output: PRIOR_USAGE.output,
					costUsd: PRIOR_USAGE.costUsd,
				}
				expectSessionSettled(session.id, result, expected, row, priorUsage)

				// col 7 — one events row of the correct §8.2 action.
				const [eventRow] = await db
					.select({ id: events.id, action: events.action })
					.from(events)
					.where(
						and(
							eq(events.entityType, 'session'),
							eq(events.entityId, session.id),
							eq(events.action, eventActionFor(kind)),
						),
					)
					.limit(1)
				expect(
					eventRow,
					`events row for ${eventActionFor(kind)} must exist after settle`,
				).toBeDefined()
			})
		}
	}

	// A single row-level idempotency probe on the additive contract: two
	// settleSession calls with the same delta must add TWICE (200 becomes 400,
	// then 600 in / 800 out — up from 100 / 200 baseline), never treat the row
	// as already-terminal on the first pass. This pins the CAS+return path on
	// real Postgres: only truly-terminal statuses lock out; a paused row can be
	// re-settled to completed (archival path).
	it('additive usage sums across two successful non-terminal-blocked settles', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			containerId: 'sbx-additive',
			agentServerId: null,
			inputTokens: PRIOR_USAGE.input,
			outputTokens: PRIOR_USAGE.output,
			totalCostUsd: String(PRIOR_USAGE.costUsd),
			config: { llm_route: 'maskin_plan' },
		})

		// First settle: pause (does NOT lock the row into the truly-terminal set).
		await settleSession(session.id, outcomeFor('pause'), makeDeps('local'))
		// Second settle: complete (paused rows can transition to completed per
		// the archival path — the CAS in settleSession excludes only 'completed',
		// 'failed', 'timeout', 'user_stopped').
		await settleSession(session.id, outcomeFor('complete'), makeDeps('local'))

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status, 'row settled to completed after paused').toBe('completed')
		expect(row?.inputTokens, 'input tokens = 100 baseline + 100 + 100').toBe(
			PRIOR_USAGE.input + DELTA_USAGE.input * 2,
		)
		expect(row?.outputTokens, 'output tokens = 200 baseline + 200 + 200').toBe(
			PRIOR_USAGE.output + DELTA_USAGE.output * 2,
		)
	})

	// §7.2: stop is the barrier, so the push must run after the sandbox stop.
	it('runs stopSandbox before pushAgentFiles', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			containerId: 'sbx-order',
			agentServerId: null,
		})
		const order: string[] = []
		await settleSession(session.id, outcomeFor('complete'), {
			...makeDeps('local'),
			stopSandbox: async () => {
				order.push('stop')
				return 'local'
			},
			pushAgentFiles: async () => {
				order.push('push')
				return 'ok'
			},
		})
		expect(order).toEqual(['stop', 'push'])
	})

	// A settle that lands on an already-terminal row skips the transaction, but
	// must still stamp session_state='done' so the reaper's session_state cutoffs
	// stop re-selecting the row. The status, event log and result are untouched.
	it.each(['starting', 'queued', 'running'] as const)(
		'stamps session_state=done on an already-completed row left in %s',
		async (staleState) => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'completed',
				sessionState: staleState,
				containerId: null,
				agentServerId: null,
			})

			const result = await settleSession(session.id, outcomeFor('fail'), makeDeps('local'))

			expect(result.alreadySettled).toBe(true)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.sessionState).toBe('done')
			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows).toEqual([])
		},
	)
})
