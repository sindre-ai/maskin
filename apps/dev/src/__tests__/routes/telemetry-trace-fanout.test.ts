import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// The stdio fan-out in `POST /api/telemetry/mcp` — the branch that turns a
// client-sink tool_call into an `mcp_tool_call` trace. Its guard exists to stop
// HTTP calls being counted twice (routes/mcp.ts already traces those
// server-side, and the in-process server's sink loops straight back here), and
// a double-count fails silently as inflated metrics rather than as an error.
const captureMcpToolCall = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/mcp-tool-calls', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/mcp-tool-calls')>()
	return { ...actual, captureMcpToolCall }
})

const { default: telemetryRoutes } = await import('../../routes/telemetry')

const wsId = '00000000-0000-0000-0000-000000000001'
const memberRow = { actorId: 'test-actor-id' }

function baseBody(overrides: Record<string, unknown> = {}) {
	return {
		event_type: 'tool_call',
		tool_name: 'list_objects',
		has_rich_render: true,
		duration_ms: 42,
		session_id: 'mcp-test-1',
		...overrides,
	}
}

async function post(body: Record<string, unknown>) {
	const { res } = await postCapturing(body)
	return res
}

/** As `post`, but also returns the rows handed to `db.insert().values()`. */
async function postCapturing(body: Record<string, unknown>) {
	const { app, mockResults, calls } = createTestApp(telemetryRoutes, '/api/telemetry')
	mockResults.select = [memberRow]
	mockResults.insert = [{}]
	const res = await app.request(
		jsonRequest('POST', '/api/telemetry/mcp', body, { 'x-workspace-id': wsId }),
	)
	// The trace is emitted as an un-awaited promise after the handler returns.
	await new Promise((r) => setImmediate(r))
	return { res, inserts: calls.inserts as Array<Record<string, unknown>> }
}

/** The trace argument of the most recent capture. */
function lastTrace(): Record<string, unknown> {
	const calls = captureMcpToolCall.mock.calls
	return calls[calls.length - 1]?.[1] as Record<string, unknown>
}

describe('stdio trace fan-out', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		captureMcpToolCall.mockResolvedValue(undefined)
	})

	// The per-SESSION metric (`mutation_session_pct`) groups `mcp_telemetry`
	// rows by `session_id`. A caller whose identity we could not resolve must
	// not land in that grouping under ANY id:
	//   - a shared constant (what `routes/mcp.ts` used to fall through to)
	//     collapses every unidentified caller in a workspace into one apparent
	//     session for the whole process uptime, so a single mutation flips the
	//     entire bucket;
	//   - the per-request throwaway that replaced it would instead inflate the
	//     denominator by one session per request.
	// Neither is a session, so no id is persisted. Both failure modes are
	// silent — the metric simply reads wrong — which is why this is pinned.
	it('persists no session id when the client reports an unknown session source', async () => {
		const { res, inserts } = await postCapturing(
			baseBody({ transport: 'http', session_source: 'unknown', session_id: 'anon-abc-123' }),
		)

		expect(res.status).toBe(202)
		expect(inserts).toHaveLength(1)
		expect(inserts[0]?.sessionId).toBeNull()
		// The per-CALL metric still counts it: an unattributable call is real
		// activity, it just isn't a session.
		expect(inserts[0]?.eventType).toBe('tool_call')
		expect(inserts[0]?.hasRichRender).toBe(true)
	})

	it('persists the session id for an attributable source', async () => {
		const { inserts } = await postCapturing(
			baseBody({ transport: 'stdio', session_source: 'maskin-session', session_id: 'sess-1' }),
		)

		expect(inserts[0]?.sessionId).toBe('sess-1')
	})

	it('emits a trace for a stdio client', async () => {
		const res = await post(baseBody({ transport: 'stdio', seq: 3, arg_keys: ['type'] }))

		expect(res.status).toBe(202)
		expect(captureMcpToolCall).toHaveBeenCalledTimes(1)
		expect(lastTrace()).toMatchObject({
			sessionId: 'mcp-test-1',
			seq: 3,
			toolName: 'list_objects',
			argKeys: ['type'],
			transport: 'stdio',
		})
	})

	// The guard this file exists for. routes/mcp.ts already emitted this call.
	it('does not emit for an http client, which routes/mcp.ts already traced', async () => {
		const res = await post(baseBody({ transport: 'http', seq: 1 }))

		expect(res.status).toBe(202)
		expect(captureMcpToolCall).not.toHaveBeenCalled()
	})

	// An older build sends no transport. stdio is the overwhelmingly likely
	// origin, and losing the trace is worse than the small double-count risk.
	it('still traces a client that sends no transport', async () => {
		await post(baseBody({ seq: 1 }))
		expect(captureMcpToolCall).toHaveBeenCalledTimes(1)
		expect(lastTrace()).toMatchObject({ transport: 'stdio' })
	})

	it('trusts the client on how it resolved its session id', async () => {
		await post(baseBody({ transport: 'stdio', session_source: 'maskin-session' }))
		expect(lastTrace()).toMatchObject({ sessionSource: 'maskin-session' })
	})

	// Never `maskin-session` by default: that tag claims a join back to the
	// sessions row, which an unlabelled id cannot be assumed to have.
	it('falls back to process when the client sends no source', async () => {
		await post(baseBody({ transport: 'stdio' }))
		expect(lastTrace()).toMatchObject({ sessionSource: 'process' })
	})

	// seq is 1-based, so 0 is out of band and would sort ahead of every real
	// call; and one shared literal id would interleave unrelated processes.
	it('uses a null seq and a unique id for a client sending neither', async () => {
		await post(baseBody({ transport: 'stdio', session_id: undefined }))

		const trace = lastTrace()
		expect(trace.seq).toBeNull()
		expect(trace.sessionSource).toBe('unknown')
		expect(String(trace.sessionId)).toMatch(/^anon-/)
	})

	it('does not collapse two id-less clients onto one session id', async () => {
		await post(baseBody({ transport: 'stdio', session_id: undefined }))
		const first = lastTrace().sessionId
		await post(baseBody({ transport: 'stdio', session_id: undefined }))

		expect(lastTrace().sessionId).not.toBe(first)
	})

	// A stdio failure carries no reason, so it is bucketed the way the HTTP path
	// buckets an unclassifiable error. Leaving it null would make stdio failures
	// indistinguishable from successes when grouping by error_class.
	it('buckets a reported failure instead of leaving error_class null', async () => {
		await post(baseBody({ transport: 'stdio', ok: false }))
		expect(lastTrace()).toMatchObject({ ok: false, errorClass: 'unclassified' })
	})

	it('leaves error_class null on success', async () => {
		await post(baseBody({ transport: 'stdio', ok: true }))
		expect(lastTrace()).toMatchObject({ ok: true, errorClass: null })
	})
})
