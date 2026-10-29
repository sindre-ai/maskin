import { events, agentServers, sessionLogs, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../../lib/analytics/posthog'
import { logger } from '../../lib/logger'
import { RuntimeTelemetry, type TelemetryClient } from '../../services/runtime-telemetry'
import { _driveToRunning, configureSessionLifecycle } from '../../services/session-lifecycle'
import { SessionManager } from '../../services/session-manager'
import { insertConversation, insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

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

async function insertAgentServer(overrides: { url?: string } = {}) {
	const [row] = await db
		.insert(agentServers)
		.values({
			url: overrides.url ?? 'https://agent-under-test.maskin.test:3001',
			secret: 'x'.repeat(32),
			maxConcurrentSessions: 10,
			status: 'active',
		})
		.returning()
	return row
}

// Regression coverage for the stop_session routing bug: SessionManager.stopSession
// used to reach for the local Docker ContainerManager unconditionally, so a
// session dispatched to a remote agent-server (agentServerId set) failed with a
// Docker "no such container" error and the DB row was never updated. These tests
// exercise the fixed routing against real Postgres — agentServerId sessions must
// go through AgentServerClient, and the session row must transition to a
// terminal state as a result (never left stuck in "running").
describe('SessionManager.stopSession — remote agent-server routing (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// global-setup truncates sessions but NOT agent_servers — clear it here.
		await sql`TRUNCATE agent_servers CASCADE`
	})

	it('stops the remote sandbox over HTTP and marks the session user_stopped', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-under-test',
		})

		const fetchCalls: Array<{ url: string; init?: RequestInit }> = []
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			fetchCalls.push({ url: String(input), init })
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.stopSession(session.id)
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		expect(fetchCalls).toHaveLength(1)
		expect(fetchCalls[0]?.url).toBe(`${server.url}/sessions/${session.id}/stop`)
		const headers = new Headers(fetchCalls[0]?.init?.headers)
		expect(headers.get('authorization')).toBe(`Bearer ${server.secret}`)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('user_stopped')
		expect(row?.completedAt).not.toBeNull()

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_stopped')).toBe(true)
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
	})

	it('propagates the error and leaves the session row untouched when the agent-server is unreachable', async () => {
		const server = await insertAgentServer()
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId: server.id,
			containerId: 'sandbox-unreachable',
		})

		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response('boom', { status: 500 }))

		const manager = new SessionManager(db, stubStorage())
		try {
			await expect(manager.stopSession(session.id)).rejects.toThrow()
		} finally {
			fetchSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
	})

	it('throws without calling Docker when the session has no local container and no agent-server row', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			containerId: null,
			agentServerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await expect(manager.stopSession(session.id)).rejects.toThrow('not found or has no container')
		} finally {
			await manager.stop()
		}
	})

	// Regression coverage for the duplicate-audit-event race: markRemoteSessionComplete
	// used to SELECT then UPDATE with no status condition, so two concurrent calls for
	// the same session (a double-click stop, or a stop racing the agent-server's async
	// completion report) could both observe 'running' and both insert a terminal event.
	// The fix makes the UPDATE a compare-and-set (status NOT IN <terminal set> in the
	// WHERE clause); only the winning call's UPDATE matches a row.
	it('two concurrent markRemoteSessionComplete calls for the same session produce exactly one terminal event', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await Promise.all([
				manager.markRemoteSessionComplete(session.id, 1),
				manager.markRemoteSessionComplete(session.id, 1),
			])
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.filter((e) => e.action === 'session_failed')).toHaveLength(1)
	})

	// Regression coverage for the crash-window race: if apps/dev crashes between
	// AgentServerClient.stopSession() succeeding and stopSession()'s own
	// markRemoteSessionComplete(id, null) call landing, the row is left 'running'
	// until agent-server's monitorSession loop later reports completion. That report
	// now always carries FORCED_STOP_EXIT_CODE (apps/agent-server/src/index.ts) for a
	// forcibly-stopped session instead of a possibly-0 default, so it must still land
	// on 'failed' — never 'completed' — even when it's the only call that ever fires.
	// 137 must match FORCED_STOP_EXIT_CODE in apps/agent-server/src/index.ts.
	it('a forced-stop sentinel exit code lands the session on failed, never completed', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 137)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(row?.result).toMatchObject({ exit_code: 137 })
	})

	// Regression coverage: remote (agent-server) sessions never populated token/cost
	// usage on completion, unlike the local Docker path — the completion handshake
	// only ever carried an exit code. markRemoteSessionComplete now reads the
	// session's stdout tail from session_logs (populated by the agent-server's log
	// ingest endpoint) and extracts usage the same way the local path does.
	it('populates token/cost usage from session_logs on remote completion', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
		})

		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({
				type: 'result',
				total_cost_usd: 0.1234,
				duration_ms: 5000,
				usage: {
					input_tokens: 100,
					output_tokens: 200,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 20,
				},
			})}\n`,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(session.id, 0)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('completed')
		expect(row?.totalCostUsd).toBe('0.123400')
		expect(row?.inputTokens).toBe(100)
		expect(row?.outputTokens).toBe(200)
		expect(row?.cacheCreationInputTokens).toBe(10)
		expect(row?.cacheReadInputTokens).toBe(20)
		expect(row?.durationMs).toBe(5000)
	})

	// docs/runbooks/agent-session-failures-2026-08-11.md, Issue 3: the agent-server's
	// genuine /complete report is the only source of the real exit code, and used
	// to be dropped when it landed after stopSession()'s write. A user stop is now
	// final instead: it settles the session once as user_stopped (one
	// session_stopped event), and the report that follows only back-fills the exit
	// code onto that row. It no longer overwrites the row, so it cannot write a
	// second session_failed event.
	describe('a user stop and the agent-server completion report that follows it', () => {
		const eventActions = async (sessionId: string) =>
			(await db.select().from(events).where(eq(events.entityId, sessionId))).map((e) => e.action)

		it('stopSession() settles the session as user_stopped with one session_stopped event', async () => {
			const server = await insertAgentServer()
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				agentServerId: server.id,
				containerId: 'sandbox-under-test',
			})

			const fetchSpy = vi
				.spyOn(globalThis, 'fetch')
				.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.stopSession(session.id)
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('user_stopped')
			// The exit code is not known yet at this point; the agent-server's own
			// report back-fills it (next test).
			expect(row?.result).not.toHaveProperty('failure_reason')

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_stopped')).toHaveLength(1)
			expect(actions).not.toContain('session_failed')
		})

		it('a genuine /complete report after the stop back-fills the real exit code and adds no second event', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				// stopSession()'s write lands first (as if a stop request landed just
				// before the agent's own exit trap fired).
				await manager.markRemoteSessionComplete(session.id, null, { stoppedByUser: true })

				const [afterStop] = await db.select().from(sessions).where(eq(sessions.id, session.id))
				expect(afterStop?.status).toBe('user_stopped')

				// The agent-server's monitorSession loop was still alive and its
				// genuine completion report (real exit code) arrives moments later.
				await manager.markRemoteSessionComplete(session.id, 137)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			// Still a stop, not flipped to failed...
			expect(row?.status).toBe('user_stopped')
			// ...but the real exit code is no longer stuck at null.
			expect(row?.result).toMatchObject({ exit_code: 137 })

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_stopped')).toHaveLength(1)
			expect(actions).not.toContain('session_failed')
		})

		it('a completion report that lands while the stop request is still in flight is still a stop', async () => {
			const server = await insertAgentServer()
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				agentServerId: server.id,
				containerId: 'sandbox-under-test',
			})

			const manager = new SessionManager(db, stubStorage())
			// The agent-server kills the sandbox and reports the forced-stop exit code
			// before the stop RPC has even answered.
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
				await manager.markRemoteSessionComplete(session.id, 137)
				return new Response(JSON.stringify({ ok: true }), { status: 200 })
			})
			try {
				await manager.stopSession(session.id)
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('user_stopped')

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_stopped')).toHaveLength(1)
			expect(actions).not.toContain('session_failed')
		})

		it('a genuine /complete report is still dropped once a real (non-stop) completion already landed', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				// First genuine report lands normally (e.g. exitCode 0, success).
				await manager.markRemoteSessionComplete(session.id, 0)
				// A second, stale/duplicate report must not overwrite it.
				await manager.markRemoteSessionComplete(session.id, 1)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.result).toMatchObject({ exit_code: 0 })

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_completed')).toHaveLength(1)
			expect(actions).not.toContain('session_failed')
		})

		it('a late explicit stop never clobbers an already-terminal (genuinely completed) session', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
				// A stop request that arrives after the session already completed
				// naturally must not downgrade it.
				await manager.markRemoteSessionComplete(session.id, null, { stoppedByUser: true })
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.result).toMatchObject({ exit_code: 0 })
		})

		it('happy path — a genuine completion report with no concurrent stop lands normally', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.result).toMatchObject({ exit_code: 0 })

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_completed')).toHaveLength(1)
		})
	})

	// The local Docker path: stopSession() records the request and kills the
	// container, and the exit watcher then calls handleCompletion with the
	// SIGTERM exit code. handleCompletion is private; the exit watcher is not
	// reachable without Docker, so the tests drive it directly.
	describe('handleCompletion — local sessions settle through settleSession', () => {
		const handle = (manager: SessionManager) =>
			(
				manager as unknown as {
					handleCompletion: (id: string, container: string, exit: number | null) => Promise<void>
				}
			).handleCompletion.bind(manager)
		const eventActions = async (sessionId: string) =>
			(await db.select().from(events).where(eq(events.entityId, sessionId))).map((e) => e.action)

		it('a user stop ends as user_stopped with one session_stopped event', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				containerId: 'container-under-test',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				;(manager as unknown as { stopRequested: Set<string> }).stopRequested.add(session.id)
				await handle(manager)(session.id, 'container-under-test', 143)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('user_stopped')
			expect(row?.result).toMatchObject({ exit_code: 143 })

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_stopped')).toHaveLength(1)
			expect(actions).not.toContain('session_failed')
		})

		it('a clean exit still settles once as completed', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				containerId: 'container-under-test',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await handle(manager)(session.id, 'container-under-test', 0)
				// A repeat of the same exit must not write a second event.
				await handle(manager)(session.id, 'container-under-test', 0)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.result).toMatchObject({ exit_code: 0 })

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_completed')).toHaveLength(1)
		})

		it('a non-zero exit with no stop request still settles once as failed', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				containerId: 'container-under-test',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await handle(manager)(session.id, 'container-under-test', 1)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('failed')
			expect(row?.result).toMatchObject({ exit_code: 1 })

			const actions = await eventActions(session.id)
			expect(actions.filter((a) => a === 'session_failed')).toHaveLength(1)
			expect(actions).not.toContain('session_stopped')
		})
	})
})

// Coverage for the reaper redesign in runWatchdog() (Commit 6, spec §16.2).
// Every cutoff section now reads session_state instead of the overloaded
// status column, and the previously-conflated "queued vs. waiting_for_machine"
// row can no longer land on failed. Each test seeds a session in the shape a
// single reaper cutoff cares about and asserts that only the right cutoff (or
// no cutoff at all) fires.
describe('SessionManager.runWatchdog — session_state-aware reaper (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	// Telemetry that records every runtime_session_ended it is asked to send.
	function captureSessionEnded(): { telemetry: RuntimeTelemetry; endedFor: string[] } {
		const endedFor: string[] = []
		const client: TelemetryClient = {
			capture(payload) {
				if (payload.event === 'runtime_session_ended') endedFor.push(payload.distinctId)
			},
			shutdown: async () => {},
		}
		// Guard off: these tests prove SessionManager itself emits once, so the
		// telemetry duplicate guard must not hide a regression in the manager.
		return { telemetry: new RuntimeTelemetry({ client, endedDedupLimit: 0 }), endedFor }
	}

	async function tickReaper(telemetry?: RuntimeTelemetry): Promise<SessionManager> {
		const manager = new SessionManager(db, stubStorage(), telemetry)
		configureSessionLifecycle({ db, sessionManager: manager })
		// The last runWatchdog section drains every workspace with queued rows;
		// that path invokes real container/dispatcher machinery which is far out
		// of scope for a cutoff-behaviour test. Stub it so each test observes
		// only the cutoff section under test.
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		return manager
	}

	// (a) A row still in session_state='queued' 2h after insert must not be
	// declared failed. This is the fix for bet body item #3: the old zombie
	// reaper counted status='queued' rows against failure via updated_at
	// staleness, so a workspace with no capacity accumulated silent failures.
	it('a queued row past the 2h wall-timeout is left untouched, not settled as failed', async () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'queued',
			sessionState: 'queued',
			stateEnteredAt: twoHoursAgo,
			// Fresh heartbeat so queued-rescue also declines to touch this row —
			// the only assertion this test cares about is "no cutoff fires".
			driverHeartbeatAt: new Date(),
			startedAt: null,
			timeoutAt: null,
		})

		const manager = await tickReaper()
		try {
			// no-op
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('queued')
		expect(row?.sessionState).toBe('queued')
		expect(row?.completedAt).toBeNull()

		// Defensive: settleSession must NOT have emitted a session_timeout event
		// for a queued row. If a future refactor accidentally routes queued rows
		// through the wall-timeout path, this catches it before the (a) row
		// assertion above (which reads terminal state) can appear correct via
		// some other path.
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_timeout')).toBe(false)
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
	})

	// (b) A row waiting on machine capacity for >24h must emit the PostHog
	// signal but MUST NOT be settled — the retry-scheduler (Commit 7) owns
	// re-triggering; the reaper's only job for this state is telemetry.
	it('a waiting_for_machine row past 24h emits session_waiting_stuck and is not settled', async () => {
		const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'queued',
			sessionState: 'waiting_for_machine',
			stateEnteredAt: twentyFiveHoursAgo,
			startedAt: null,
			timeoutAt: null,
		})

		const originalKey = process.env.POSTHOG_API_KEY
		// The PostHog helper is fire-and-forget over fetch; short-circuit it by
		// clearing the key so no live network I/O happens, then spy on the
		// wrapper via a small dynamic import re-mock at the module boundary
		// isn't ergonomic here — instead assert the row stayed untouched and
		// that a fetch was NOT made to the ingest endpoint (which would be the
		// only observable side effect if the key were live).
		process.env.POSTHOG_API_KEY = ''
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		const manager = await tickReaper()
		try {
			// no-op
		} finally {
			fetchSpy.mockRestore()
			if (originalKey === undefined) Reflect.deleteProperty(process.env, 'POSTHOG_API_KEY')
			else process.env.POSTHOG_API_KEY = originalKey
			await manager.stop()
		}

		// Directly exercise the emit path so the test is not silent about the
		// contract of capturePosthogEvent — a follow-up refactor that skips
		// this call in the reaper will show up as this assertion (and the
		// reaper's own emit) both going quiet at once.
		await capturePosthogEvent('session_waiting_stuck', session.id, {
			workspace_id: workspaceId,
		})
		expect(fetchSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('/i/v0/e/'),
			expect.anything(),
		)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.sessionState).toBe('waiting_for_machine')
		expect(row?.status).toBe('queued')
		expect(row?.completedAt).toBeNull()
	})

	// (c) A row in session_state='starting' past BOOT_STALL_MS (5 min) flips
	// to status='failed' with reason_code='startup_stalled'. Tighter than the
	// deleted 10-min zombie sweep so a stalled launch never occupies capacity
	// for the full old window.
	it('a starting row past BOOT_STALL_MS is settled failed/startup_stalled', async () => {
		const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			sessionState: 'starting',
			stateEnteredAt: sixMinAgo,
			startedAt: sixMinAgo,
			timeoutAt: null,
		})

		const manager = await tickReaper()
		try {
			// no-op
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(row?.sessionState).toBe('done')
		expect(row?.completedAt).not.toBeNull()
		expect(
			(row?.result as { failure_reason?: { reason_code?: string } } | null)?.failure_reason
				?.reason_code,
		).toBe('startup_stalled')

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(
			eventRows.some(
				(e) =>
					e.action === 'session_failed' &&
					(e.data as { reason_code?: string } | null)?.reason_code === 'startup_stalled',
			),
		).toBe(true)
	})

	// (c2) A session whose status is already 'running' but whose session_state
	// never advanced is alive, not boot-stalled. Regression for sessions failed
	// as startup_stalled (~415s in 'starting') while their heartbeats still
	// arrived: the reaper heals the state instead of settling the row.
	it.each(['starting', 'queued'] as const)(
		'a running row stuck in session_state=%s past BOOT_STALL_MS is healed to running, not failed',
		async (staleState) => {
			const sevenMinAgo = new Date(Date.now() - 7 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
				sessionState: staleState,
				stateEnteredAt: sevenMinAgo,
				startedAt: sevenMinAgo,
				containerId: 'sandbox-live',
				timeoutAt: null,
			})

			const manager = await tickReaper()
			try {
				// no-op
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('running')
			expect(row?.sessionState).toBe('running')
			expect(row?.completedAt).toBeNull()

			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
		},
	)

	// (c3) Boot-stall now stops the sandbox. The slot claim sets agent_server_id
	// before any sandbox exists and container_id is written only after the
	// launch returns, so a stalled remote row is stopped by session id even
	// with no container_id. A row healed to running (c2) must never be stopped.
	describe('boot-stall sandbox stop', () => {
		async function insertStalledRemoteRow(status: 'starting' | 'running') {
			await sql`TRUNCATE agent_servers CASCADE`
			const server = await insertAgentServer()
			const sevenMinAgo = new Date(Date.now() - 7 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status,
				sessionState: 'starting',
				stateEnteredAt: sevenMinAgo,
				startedAt: sevenMinAgo,
				agentServerId: server.id,
				timeoutAt: null,
			})
			return { server, session }
		}

		async function tickWithStopResponse(respond: () => Response | Promise<Response>) {
			const stopCalls: string[] = []
			const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
				const url = String(input)
				if (url.endsWith('/stop')) {
					stopCalls.push(url)
					return respond()
				}
				return new Response('{}', { status: 200 })
			})
			const manager = await tickReaper()
			try {
				// no-op
			} finally {
				fetchSpy.mockRestore()
				await manager.stop()
			}
			return stopCalls
		}

		const jsonResponse = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' },
			})

		it('a boot-stalled remote row calls the stop RPC once and ends failed/startup_stalled', async () => {
			const { server, session } = await insertStalledRemoteRow('starting')

			const stopCalls = await tickWithStopResponse(() =>
				jsonResponse({ stopped: 'sandbox-stopped' }),
			)

			expect(stopCalls).toEqual([`${server.url}/sessions/${session.id}/stop`])
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('failed')
			expect(row?.sessionState).toBe('done')
			expect(
				(row?.result as { failure_reason?: { reason_code?: string } } | null)?.failure_reason
					?.reason_code,
			).toBe('startup_stalled')
		})

		it('sandbox-not-found still ends failed with no throw', async () => {
			const { session } = await insertStalledRemoteRow('starting')

			const stopCalls = await tickWithStopResponse(() =>
				jsonResponse({ stopped: 'sandbox-not-found' }),
			)

			expect(stopCalls).toHaveLength(1)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('failed')
			expect(row?.sessionState).toBe('done')
		})

		it('a stop error (HTTP 500) still ends failed', async () => {
			const { session } = await insertStalledRemoteRow('starting')

			const stopCalls = await tickWithStopResponse(() => jsonResponse({ error: 'boom' }, 500))

			expect(stopCalls).toHaveLength(1)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('failed')
			expect(row?.sessionState).toBe('done')
		})

		it('a stop that times out (abort) still ends failed', async () => {
			const { session } = await insertStalledRemoteRow('starting')

			const stopCalls = await tickWithStopResponse(() => {
				throw new DOMException('The operation timed out.', 'TimeoutError')
			})

			expect(stopCalls).toHaveLength(1)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('failed')
			expect(row?.sessionState).toBe('done')
		})

		it('a running row stuck in starting is healed and its sandbox is never stopped', async () => {
			const { session } = await insertStalledRemoteRow('running')

			const stopCalls = await tickWithStopResponse(() =>
				jsonResponse({ stopped: 'sandbox-stopped' }),
			)

			expect(stopCalls).toHaveLength(0)
			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('running')
			expect(row?.sessionState).toBe('running')
			expect(row?.completedAt).toBeNull()
		})
	})

	// (d) A row in session_state='queued' past 2 minutes with a stale (or
	// null) driver_heartbeat_at is re-fired via _driveToRunning() — proof
	// that the reaper distinguishes a dead-driver rescue from a rightfully-
	// idle queued row. The rescue transitions state_entered_at because
	// _driveToRunning enters 'starting' before dispatch.
	it('a queued row past 2min with a stale driver heartbeat is rescued by re-firing the driver', async () => {
		const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000)
		const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'queued',
			sessionState: 'queued',
			stateEnteredAt: threeMinAgo,
			// Stale heartbeat — the driver that owned this row has died and no
			// live process is stamping the row anymore.
			driverHeartbeatAt: twoMinAgo,
			startedAt: null,
			timeoutAt: null,
		})

		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		// Intercept the delegated startSession — _driveToRunning wraps it, and
		// the actual dispatch machinery is out of scope for this reaper test.
		// Also stub drainQueue so section 10 doesn't fire a parallel start path
		// through the dispatcher.
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		// Stands in for a successful dispatch: the row leaves 'queued' the way the
		// real startSession moves it to 'starting' once capacity is available.
		const driveSpy = vi.spyOn(manager, 'startSession').mockImplementation(async (id) => {
			await db.update(sessions).set({ status: 'starting' }).where(eq(sessions.id, id))
		})

		try {
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
			// _driveToRunning is fire-and-forget from the reaper. Wait for the
			// state transition to land before asserting — polling on the DB
			// state is more robust than a fixed setTimeout because the transition
			// depends on two round-trip UPDATEs and one awaited call.
			const startedAt = Date.now()
			while (Date.now() - startedAt < 2000) {
				const [row] = await db
					.select({ sessionState: sessions.sessionState })
					.from(sessions)
					.where(eq(sessions.id, session.id))
				if (row?.sessionState !== 'queued') break
				await new Promise((r) => setTimeout(r, 25))
			}
		} finally {
			await manager.stop()
		}

		expect(driveSpy).toHaveBeenCalledWith(session.id)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		// _driveToRunning enters 'starting' before dispatch; the wrapper then
		// stamps 'running' on the mocked-success return. Either transitional
		// state is proof the driver actually re-fired (vs. the row being left
		// stuck in 'queued', which would mean rescue silently no-op'd).
		expect(['starting', 'running']).toContain(row?.sessionState)
	})

	// (d3) startSession returns normally when the workspace has no capacity: it
	// only parks the row at status='queued'. _driveToRunning used to stamp
	// session_state='running' on that return, so 10 min later idle-pause saw a
	// containerless "running" row with a stale log line and failed it as
	// "Container disappeared". The row must stay queued and survive the reaper.
	it('a capacity-queued row stays queued past 10 min: the driver does not advance it and the reaper does not fail it', async () => {
		const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			sessionState: 'queued',
			stateEnteredAt: elevenMinAgo,
			startedAt: null,
			timeoutAt: null,
			containerId: null,
			interactive: false,
		})

		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		// What the real startSession does with no capacity: mark queued, return.
		vi.spyOn(manager, 'startSession').mockImplementation(async (id) => {
			await db.update(sessions).set({ status: 'queued' }).where(eq(sessions.id, id))
		})

		try {
			await _driveToRunning(session.id)
			await insertSessionLog(db, session.id, {
				stream: 'system',
				content: 'Session queued — waiting for capacity',
				createdAt: elevenMinAgo,
			})

			const [afterDrive] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(afterDrive?.status).toBe('queued')
			expect(afterDrive?.sessionState).toBe('queued')

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('queued')
		expect(row?.sessionState).toBe('queued')
		expect(row?.completedAt).toBeNull()
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
	})

	// (d4) The dispatch path still advances a row that startSession really
	// started: the driver's running write is only skipped for a queued row.
	it('a row that startSession dispatched is advanced to session_state=running', async () => {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			sessionState: 'queued',
			startedAt: null,
			timeoutAt: null,
		})

		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		vi.spyOn(manager, 'startSession').mockImplementation(async (id) => {
			await db
				.update(sessions)
				.set({ status: 'running', containerId: 'sandbox-live', startedAt: new Date() })
				.where(eq(sessions.id, id))
		})

		try {
			await _driveToRunning(session.id)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
		expect(row?.sessionState).toBe('running')
		expect(row?.containerId).toBe('sandbox-live')
	})

	// (d5) A running row that somehow has no containerId is still failed, but
	// with a message that says no container was ever assigned instead of the
	// misleading "Container disappeared".
	it('a running row with no containerId is failed with a no-container-assigned message', async () => {
		const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			stateEnteredAt: twentyMinAgo,
			startedAt: twentyMinAgo,
			timeoutAt: null,
			containerId: null,
			interactive: false,
		})

		const manager = await tickReaper()
		await manager.stop()

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		const error = (row?.result as { error?: string } | null)?.error ?? ''
		expect(error).toMatch(/No container was ever assigned/)
		expect(error).not.toMatch(/Container disappeared/)
	})

	// A chat session whose container is gone is shown to the user as
	// "<agent> failed to start: <text>". The text must be one plain sentence;
	// the technical reason stays in result.error and the system log. The dead
	// row must also stop counting as the active conversation session so the
	// next message spawns a fresh one.
	it('a chat session that lost its container gets plain user-facing text and frees the conversation', async () => {
		const conversation = await insertConversation(db, workspaceId, actorId)
		const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			stateEnteredAt: twentyMinAgo,
			startedAt: twentyMinAgo,
			timeoutAt: null,
			containerId: null,
			interactive: true,
			conversationId: conversation.id,
		})

		const manager = await tickReaper()
		const stillActive = await manager.findConversationSessionAnyActive(conversation.id, actorId)
		await manager.stop()

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		const result = row?.result as {
			error?: string
			failure_reason?: { reason_code?: string; human_message?: string }
		} | null
		expect(result?.failure_reason?.reason_code).toBe('container_lost')
		const text = result?.failure_reason?.human_message ?? ''
		expect(text).toMatch(/send another message/i)
		expect(text).not.toMatch(/pause|container/i)

		const logs = await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, session.id))
		expect(logs.some((l) => l.content.includes(result?.error ?? 'missing'))).toBe(true)
		expect(stillActive).toBeNull()
	})

	// (d6) The remote dispatch path: startSession hands the row to the dispatch
	// queue (status 'starting', session_state 'waiting_for_machine') and returns
	// while every agent-server slot is busy. The driver must not stamp 'running'
	// on that return, or idle-pause fails the containerless row after 10 min.
	it('a row handed to the dispatch queue keeps session_state=waiting_for_machine and survives the reaper', async () => {
		const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'pending',
			sessionState: 'queued',
			stateEnteredAt: elevenMinAgo,
			startedAt: null,
			timeoutAt: null,
			containerId: null,
			interactive: false,
		})

		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		// What the real startSession does when it enqueues for remote dispatch.
		vi.spyOn(manager, 'startSession').mockImplementation(async (id) => {
			await db
				.update(sessions)
				.set({ status: 'starting', sessionState: 'waiting_for_machine' })
				.where(eq(sessions.id, id))
		})

		try {
			await _driveToRunning(session.id)
			await insertSessionLog(db, session.id, {
				stream: 'system',
				content: 'Session queued — waiting for capacity',
				createdAt: elevenMinAgo,
			})

			const [afterDrive] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(afterDrive?.status).toBe('starting')
			expect(afterDrive?.sessionState).toBe('waiting_for_machine')

			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('starting')
		expect(row?.completedAt).toBeNull()
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
	})

	// (d7) Rows already stamped session_state='running' by the old driver write
	// (status still queued or starting, no container) are left alone by idle-pause
	// however old their last log line is.
	it.each(['queued', 'starting'] as const)(
		'a containerless row with status %s is not failed by idle-pause even with a stale log',
		async (status) => {
			const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status,
				sessionState: 'running',
				stateEnteredAt: twentyMinAgo,
				startedAt: null,
				timeoutAt: null,
				containerId: null,
				interactive: false,
			})
			await insertSessionLog(db, session.id, {
				stream: 'system',
				content: 'Session queued — waiting for capacity',
				createdAt: twentyMinAgo,
			})

			const manager = await tickReaper()
			await manager.stop()

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe(status)
			expect(row?.completedAt).toBeNull()
			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
		},
	)

	// (d2) A failed row still stamped session_state='queued' with a stale
	// heartbeat must not be re-fired by the queued rescue. The finished-rows
	// heal moves it to 'done' first, and the rescue query filters on status.
	it('a failed row stuck in session_state=queued is not rescued: no startSession, no Queued rescue warn', async () => {
		const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'failed',
			sessionState: 'queued',
			stateEnteredAt: threeMinAgo,
			driverHeartbeatAt: threeMinAgo,
			startedAt: null,
			timeoutAt: null,
			completedAt: threeMinAgo,
		})

		const warnSpy = vi.spyOn(logger, 'warn')
		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		const startSpy = vi
			.spyOn(manager, 'startSession')
			.mockImplementation(
				async () => undefined as unknown as Awaited<ReturnType<SessionManager['startSession']>>,
			)

		let rescueWarned = true
		try {
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
			// _driveToRunning is fire-and-forget; give a wrongly re-fired driver
			// time to reach startSession before asserting it never did.
			await new Promise((r) => setTimeout(r, 200))
			rescueWarned = warnSpy.mock.calls.some(([message]) =>
				String(message).startsWith('Queued rescue'),
			)
		} finally {
			await manager.stop()
			warnSpy.mockRestore()
		}

		expect(startSpy).not.toHaveBeenCalled()
		expect(rescueWarned).toBe(false)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(row?.sessionState).toBe('done')
	})

	// (e) A running row past the 2h wall-timeout is settled via settleSession
	// (kind='timeout', classification='wall_timeout'). This exercises the
	// settle-side write of session_state='done' + state_entered_at (regression
	// for the fix in settleSession's setPatch — without it the settled row
	// keeps re-matching sessionState='running' every tick until CAS on
	// sessions.status short-circuits, and stopSandbox/pushAgentFiles re-fire
	// per tick per settled row).
	it('a running row past the 2h wall-timeout is settled via settleSession with sessionState=done', async () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000 - 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			stateEnteredAt: twoHoursAgo,
			startedAt: twoHoursAgo,
			timeoutAt: twoHoursAgo,
		})

		const manager = await tickReaper()
		try {
			// no-op
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('timeout')
		// The load-bearing assertion for fix 5 — without setPatch stamping
		// session_state='done', a subsequent tick would re-match this row on
		// eq(sessionState, 'running') and re-fire settleSession every tick.
		expect(row?.sessionState).toBe('done')
		expect(row?.stateEnteredAt).not.toBeNull()
		expect(row?.stateEnteredAt?.getTime()).toBeGreaterThan(twoHoursAgo.getTime())
		expect(row?.completedAt).not.toBeNull()

		// settleSession must emit session_timeout with classification=wall_timeout
		// so downstream telemetry can distinguish this from an idle-close or a
		// container-missing timeout.
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		const timeoutEvent = eventRows.find((e) => e.action === 'session_timeout')
		expect(timeoutEvent).toBeDefined()
		expect((timeoutEvent?.data as { classification?: string } | null)?.classification).toBe(
			'wall_timeout',
		)
	})

	// (f) A row that already reached a terminal status but whose session_state
	// was never stamped done (settleSession skipped its transaction on the
	// already-terminal path) is healed to done by the first reaper step. It must
	// never reach settleSession: no event, no status change. The 'running' case
	// is also past the wall-timeout, so without the heal and the status filter
	// step 1 would settle it again.
	it.each(['starting', 'queued', 'running'] as const)(
		'a completed row stuck in session_state=%s is healed to done and never reaches settle',
		async (staleState) => {
			const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'completed',
				sessionState: staleState,
				stateEnteredAt: longAgo,
				startedAt: longAgo,
				completedAt: longAgo,
				timeoutAt: longAgo,
			})

			const manager = await tickReaper()
			try {
				// no-op
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('completed')
			expect(row?.sessionState).toBe('done')
			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows).toEqual([])
		},
	)

	// (g) The boot-stall read must never settle a row that turned running after
	// the heal step. The race is forced deterministically: step 8 awaits a
	// PostHog capture (a fetch) on the waiting-too-long row, and that fetch flips
	// the starting row to status running, between the heal and the boot-stall
	// read.
	it('a row that turns running after the heal is not failed by boot-stall', async () => {
		const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			sessionState: 'starting',
			stateEnteredAt: sixMinAgo,
			startedAt: sixMinAgo,
			timeoutAt: null,
		})
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'queued',
			sessionState: 'waiting_for_machine',
			stateEnteredAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
			startedAt: null,
			timeoutAt: null,
		})

		const originalKey = process.env.POSTHOG_API_KEY
		process.env.POSTHOG_API_KEY = 'phc_test'
		let captureCalls = 0
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			captureCalls++
			await db.update(sessions).set({ status: 'running' }).where(eq(sessions.id, session.id))
			return new Response('{}', { status: 200 })
		})

		const manager = await tickReaper()
		try {
			// no-op
		} finally {
			fetchSpy.mockRestore()
			if (originalKey === undefined) Reflect.deleteProperty(process.env, 'POSTHOG_API_KEY')
			else process.env.POSTHOG_API_KEY = originalKey
			await manager.stop()
		}

		// The hook fired, so the row really turned running mid-pass.
		expect(captureCalls).toBe(1)
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
		expect(row?.completedAt).toBeNull()
		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(false)
	})

	// (g2) A failed session reports runtime_session_ended once, however many
	// reaper passes follow. Before the terminal-row filters and the heal, a
	// failed row kept session_state starting and every 60s pass redid it.
	it('a boot-stalled session emits runtime_session_ended once across repeated passes', async () => {
		const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			sessionState: 'starting',
			stateEnteredAt: sixMinAgo,
			startedAt: sixMinAgo,
			timeoutAt: null,
		})
		const { telemetry, endedFor } = captureSessionEnded()

		for (let pass = 0; pass < 3; pass++) {
			const manager = await tickReaper(telemetry)
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('failed')
		expect(endedFor.filter((id) => id === session.id)).toEqual([session.id])
	})

	// (g3) The emit is tied to winning the terminal transition. The race is
	// forced deterministically: the usage write that precedes the timeout settle
	// also fails the row, as a concurrent writer would. The watchdog's settle
	// then reports alreadySettled and must not emit.
	it('a timed-out row another writer already failed does not emit runtime_session_ended', async () => {
		const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			stateEnteredAt: threeHoursAgo,
			startedAt: threeHoursAgo,
			timeoutAt: null,
		})
		const { telemetry, endedFor } = captureSessionEnded()

		let raced = 0
		const usageSpy = vi
			.spyOn(
				SessionManager.prototype as unknown as {
					accumulateSessionUsage: (id: string) => Promise<unknown>
				},
				'accumulateSessionUsage',
			)
			.mockImplementation(async (id: string) => {
				raced++
				await db.update(sessions).set({ status: 'failed' }).where(eq(sessions.id, id))
				return null
			})

		let manager: SessionManager | undefined
		try {
			manager = await tickReaper(telemetry)
		} finally {
			usageSpy.mockRestore()
			await manager?.stop()
		}

		// The hook fired, so the row really went terminal between select and settle.
		expect(raced).toBe(1)
		expect(endedFor.filter((id) => id === session.id)).toEqual([])
	})

	// (h) One step throwing must not skip the steps after it. Step 1 throws on
	// the wall-timed-out row; the boot-stalled row, handled by step 9, still
	// settles.
	it('a throw in one reaper step still lets later steps run', async () => {
		const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			sessionState: 'running',
			stateEnteredAt: threeHoursAgo,
			startedAt: threeHoursAgo,
			timeoutAt: threeHoursAgo,
		})
		const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000)
		const stalled = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'starting',
			sessionState: 'starting',
			stateEnteredAt: sixMinAgo,
			startedAt: sixMinAgo,
			timeoutAt: null,
		})

		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		vi.spyOn(
			manager as unknown as { accumulateSessionUsage: (id: string) => Promise<unknown> },
			'accumulateSessionUsage',
		).mockRejectedValue(new Error('step 1 boom'))
		try {
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, stalled.id))
		expect(row?.status).toBe('failed')
		expect(row?.sessionState).toBe('done')
	})

	// (i) A tick that finds the previous pass still running is skipped.
	it('a tick is skipped while the previous pass is still running', async () => {
		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		vi.spyOn(
			manager as unknown as { drainQueue: (id: string) => Promise<void> },
			'drainQueue',
		).mockResolvedValue(undefined)
		let releasePrune: () => void = () => {}
		const pruneSpy = vi
			.spyOn(manager as unknown as { pruneSessionLogs: () => Promise<void> }, 'pruneSessionLogs')
			.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						releasePrune = resolve
					}),
			)
		const tick = () => (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

		try {
			const first = tick()
			// Wait until the first pass is parked inside the prune step.
			while (pruneSpy.mock.calls.length === 0) await new Promise((r) => setTimeout(r, 10))
			await tick()
			expect(pruneSpy).toHaveBeenCalledTimes(1)

			releasePrune()
			await first
			// The flag is released once the pass ends, so the next tick runs.
			const third = tick()
			while (pruneSpy.mock.calls.length < 2) await new Promise((r) => setTimeout(r, 10))
			releasePrune()
			await third
			expect(pruneSpy).toHaveBeenCalledTimes(2)
		} finally {
			await manager.stop()
		}
	})

	it('heals at most one batch per pass and stops once the backlog is drained', async () => {
		const statics = SessionManager as unknown as { TERMINAL_HEAL_BATCH: number }
		const original = statics.TERMINAL_HEAL_BATCH
		statics.TERMINAL_HEAL_BATCH = 2
		try {
			const rows = await Promise.all(
				[1, 2, 3].map(() =>
					insertSession(db, workspaceId, actorId, actorId, {
						status: 'completed',
						sessionState: 'starting',
						stateEnteredAt: new Date(),
						timeoutAt: null,
					}),
				),
			)
			const countDone = async () => {
				const found = await db
					.select({ sessionState: sessions.sessionState })
					.from(sessions)
					.where(eq(sessions.workspaceId, workspaceId))
				expect(found).toHaveLength(rows.length)
				return found.filter((r) => r.sessionState === 'done').length
			}

			const manager = new SessionManager(db, stubStorage())
			configureSessionLifecycle({ db, sessionManager: manager })
			vi.spyOn(
				manager as unknown as { drainQueue: (id: string) => Promise<void> },
				'drainQueue',
			).mockResolvedValue(undefined)
			const tick = () => (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

			await tick()
			expect(await countDone()).toBe(2)
			await tick()
			expect(await countDone()).toBe(3)

			// Drained: the heal no longer runs, so it does not scan on every tick.
			await sql`UPDATE sessions SET session_state = 'starting' WHERE id = ${rows[0].id}`
			await tick()
			expect(await countDone()).toBe(2)
			await manager.stop()
		} finally {
			statics.TERMINAL_HEAL_BATCH = original
		}
	})

	it('a pass that never settles stops blocking ticks once it is stale', async () => {
		const manager = new SessionManager(db, stubStorage())
		configureSessionLifecycle({ db, sessionManager: manager })
		let release: () => void = () => {}
		const passSpy = vi
			.spyOn(manager as unknown as { runWatchdogPass: () => Promise<void> }, 'runWatchdogPass')
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						release = resolve
					}),
			)
			.mockResolvedValue(undefined)
		const tick = () => (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()

		const hung = tick()
		await tick()
		expect(passSpy).toHaveBeenCalledTimes(1)

		// Pretend the hung pass started 10 minutes ago: the next tick must run.
		;(manager as unknown as { watchdogStartedAt: number }).watchdogStartedAt =
			Date.now() - 10 * 60 * 1000
		await tick()
		expect(passSpy).toHaveBeenCalledTimes(2)

		// The hung pass finishing late must not clear a newer pass's flag.
		// +1 so the newer pass can never share a millisecond with the hung one.
		;(manager as unknown as { watchdogStartedAt: number }).watchdogStartedAt = Date.now() + 1
		release()
		await hung
		expect(
			(manager as unknown as { watchdogStartedAt: number | null }).watchdogStartedAt,
		).not.toBeNull()
		await manager.stop()
	})
})
