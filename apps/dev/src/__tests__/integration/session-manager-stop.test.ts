import { events, agentServers, sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
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

	it('stops the remote sandbox over HTTP and marks the session failed', async () => {
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
		expect(row?.status).toBe('failed')
		expect(row?.completedAt).not.toBeNull()

		const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
		expect(eventRows.some((e) => e.action === 'session_failed')).toBe(true)
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

	// Regression coverage for the null-exit-code race documented in
	// docs/runbooks/agent-session-failures-2026-08-11.md, Issue 3: stopSession()
	// used to write result.exit_code: null unconditionally and authoritatively,
	// so a genuine /complete report that landed moments later (carrying the
	// agent's real exit code) matched 0 rows in the CAS UPDATE and silently
	// no-op'd — session 4d1f3c8b ended up stored with exit_code: null even
	// though msb's own log showed it successfully reported exitCode: 1.
	//
	// stopSession()'s null write is now marked provisional (stoppedByUser:
	// true in markRemoteSessionComplete's opts, persisted as
	// result.stopped_by_user), and a later genuine report is allowed to
	// overwrite a row still carrying that marker.
	describe('exit-code race between an explicit stop and a genuine completion report', () => {
		it('stopSession() writes a provisional null exit code marked stopped_by_user', async () => {
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
			expect(row?.status).toBe('failed')
			expect(row?.result).toMatchObject({ exit_code: null, stopped_by_user: true })
		})

		it("a genuine /complete report overwrites stopSession()'s provisional null exit code with the real one", async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				// Simulate stopSession()'s eager, provisional write winning the race
				// first (as if a stop request landed just before the agent's own
				// exit trap fired).
				await manager.markRemoteSessionComplete(session.id, null, { stoppedByUser: true })

				const [afterStop] = await db.select().from(sessions).where(eq(sessions.id, session.id))
				expect(afterStop?.status).toBe('failed')
				expect(afterStop?.result).toMatchObject({ exit_code: null, stopped_by_user: true })

				// The agent-server's monitorSession loop was still alive and its
				// genuine completion report (real exit code) arrives moments later.
				await manager.markRemoteSessionComplete(session.id, 1)
			} finally {
				await manager.stop()
			}

			const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
			expect(row?.status).toBe('failed')
			// The real exit code must win — not stay stuck at null — and the
			// provisional marker must be cleared by the genuine report.
			expect(row?.result).toMatchObject({ exit_code: 1 })
			expect((row?.result as { stopped_by_user?: boolean } | null)?.stopped_by_user).toBeFalsy()

			// Both the provisional and the corrected write produced a terminal
			// event — an operator inspecting the audit log can see the exit code
			// was corrected, not just silently dropped.
			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows.filter((e) => e.action === 'session_failed')).toHaveLength(2)
		})

		// The logging side of this behavior (item 3 in the runbook's suggested
		// fix — surfacing the previously-silent no-op) is covered by a mocked-DB
		// unit test instead: apps/dev/src/__tests__/services/session-manager.test.ts,
		// "logs a warning with the dropped exit code when the CAS update matches
		// no row". Vitest's console/stdout attribution under this suite's
		// `pool: 'forks', poolOptions: { forks: { singleFork: true } }` config
		// (see apps/dev/vitest.integration.config.ts) intercepts `console.log`
		// per-test in a way that defeats `vi.spyOn(console, 'log')` here — the
		// real log line was confirmed (by hand, against this exact scenario) to
		// print with the correct msg/sessionId/droppedExitCode/currentStatus,
		// but that isn't reliably assertable from this test file. The behavioral
		// (data-integrity) half of this scenario — that the stale report is
		// correctly ignored and never overwrites the genuine completion — is
		// still fully covered below.
		it('a genuine /complete report is still dropped once a real (non-provisional) completion already landed', async () => {
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

			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows.filter((e) => e.action === 'session_completed')).toHaveLength(1)
			expect(eventRows.filter((e) => e.action === 'session_failed')).toHaveLength(0)
		})

		it('a late explicit stop never clobbers an already-terminal (genuinely completed) session', async () => {
			const session = await insertSession(db, workspaceId, actorId, actorId, {
				status: 'running',
			})

			const manager = new SessionManager(db, stubStorage())
			try {
				await manager.markRemoteSessionComplete(session.id, 0)
				// A stop request that arrives after the session already completed
				// naturally must not downgrade it to failed/null.
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
			expect((row?.result as { stopped_by_user?: boolean } | null)?.stopped_by_user).toBeFalsy()

			const eventRows = await db.select().from(events).where(eq(events.entityId, session.id))
			expect(eventRows.filter((e) => e.action === 'session_completed')).toHaveLength(1)
		})
	})
})
