import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../../lib/logger'
import { jsonRequest } from '../helpers'
import { createSessionTestApp, createTestApp } from '../setup'

const { default: agentServerReconcileRoutes } = await import('../../routes/agent-server-reconcile')

const SECRET = 'test-shared-secret'
const agentServerId = '11111111-1111-1111-1111-111111111111'
const sessionId = '22222222-2222-2222-2222-222222222222'

function bodyWith(overrides: Partial<{ agent_server_id: string; sandboxes: string[] }> = {}) {
	return {
		agent_server_id: agentServerId,
		sandboxes: ['sandbox-a'],
		...overrides,
	}
}

describe('POST /api/internal/agent-servers/reconcile', () => {
	beforeEach(() => {
		vi.stubEnv('AGENT_SERVER_SECRET', SECRET)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('reconciles a snapshot and returns marked-failed + orphan lists', async () => {
		const { app, mockResults } = createTestApp(
			agentServerReconcileRoutes,
			'/api/internal/agent-servers',
		)
		mockResults.select = [
			{
				id: sessionId,
				workspaceId: 'ws-1',
				actorId: 'actor-1',
				containerId: 'sandbox-lost',
				status: 'running',
			},
		]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/internal/agent-servers/reconcile',
				bodyWith({ sandboxes: ['sandbox-alive', 'sandbox-orphan'] }),
				{ Authorization: `Bearer ${SECRET}` },
			),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.marked_failed).toEqual([sessionId])
		expect(body.orphan_sandboxes).toEqual(['sandbox-alive', 'sandbox-orphan'])
	})

	it('returns 401 when the Authorization header is missing', async () => {
		const { app } = createTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest('POST', '/api/internal/agent-servers/reconcile', bodyWith()),
		)

		expect(res.status).toBe(401)
	})

	it('returns 401 when the bearer token does not match', async () => {
		const { app } = createTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest('POST', '/api/internal/agent-servers/reconcile', bodyWith(), {
				Authorization: 'Bearer wrong-secret',
			}),
		)

		expect(res.status).toBe(401)
	})

	it('returns 401 when only the Bearer prefix is present', async () => {
		const { app } = createTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest('POST', '/api/internal/agent-servers/reconcile', bodyWith(), {
				Authorization: 'Bearer ',
			}),
		)

		expect(res.status).toBe(401)
	})

	it('returns 503 when AGENT_SERVER_SECRET is not configured', async () => {
		vi.stubEnv('AGENT_SERVER_SECRET', '')
		const { app } = createTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest('POST', '/api/internal/agent-servers/reconcile', bodyWith(), {
				Authorization: `Bearer ${SECRET}`,
			}),
		)

		expect(res.status).toBe(503)
	})

	it('returns 400 when the body is missing required fields', async () => {
		const { app } = createTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/internal/agent-servers/reconcile',
				{ sandboxes: ['sandbox-a'] } as unknown,
				{ Authorization: `Bearer ${SECRET}` },
			),
		)

		expect(res.status).toBe(400)
	})

	it('returns 400 when agent_server_id is not a UUID', async () => {
		const { app } = createTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/internal/agent-servers/reconcile',
				bodyWith({ agent_server_id: 'not-a-uuid' }),
				{ Authorization: `Bearer ${SECRET}` },
			),
		)

		expect(res.status).toBe(400)
	})
})

describe('POST /api/internal/agent-servers/sessions/:id/logs', () => {
	beforeEach(() => {
		vi.stubEnv('AGENT_SERVER_SECRET', SECRET)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	function logsPath(id = sessionId) {
		return `/api/internal/agent-servers/sessions/${id}/logs`
	}

	it('accepts a normal-size log batch', async () => {
		const { app, sessionManager } = createSessionTestApp(
			agentServerReconcileRoutes,
			'/api/internal/agent-servers',
		)
		sessionManager.appendRemoteSessionLogs = vi.fn().mockResolvedValue(undefined)

		const logs = [
			{ stream: 'stdout', content: 'agent starting up' },
			{ stream: 'stderr', content: 'a warning' },
		]
		const res = await app.request(
			jsonRequest('POST', logsPath(), { logs }, { Authorization: `Bearer ${SECRET}` }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.accepted).toBe(2)
		expect(sessionManager.appendRemoteSessionLogs).toHaveBeenCalledWith(sessionId, logs)
	})

	it('accepts a line that would have failed the old 64KB cap', async () => {
		const { app, sessionManager } = createSessionTestApp(
			agentServerReconcileRoutes,
			'/api/internal/agent-servers',
		)
		sessionManager.appendRemoteSessionLogs = vi.fn().mockResolvedValue(undefined)

		// 100KB — over the old 65536-byte cap, well under the new 1MB cap.
		const bigLine = 'x'.repeat(100_000)
		const res = await app.request(
			jsonRequest(
				'POST',
				logsPath(),
				{ logs: [{ stream: 'stdout', content: bigLine }] },
				{ Authorization: `Bearer ${SECRET}` },
			),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.accepted).toBe(1)
		expect(sessionManager.appendRemoteSessionLogs).toHaveBeenCalledWith(sessionId, [
			{ stream: 'stdout', content: bigLine },
		])
	})

	it('drops an oversized line but keeps the rest of the batch (partial-failure-tolerant)', async () => {
		const { app, sessionManager } = createSessionTestApp(
			agentServerReconcileRoutes,
			'/api/internal/agent-servers',
		)
		sessionManager.appendRemoteSessionLogs = vi.fn().mockResolvedValue(undefined)
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		// Over the new 1MB cap.
		const tooLarge = 'x'.repeat(1_100_000)
		const logs = [
			{ stream: 'stdout', content: 'a normal line' },
			{ stream: 'stdout', content: tooLarge },
		]
		const res = await app.request(
			jsonRequest('POST', logsPath(), { logs }, { Authorization: `Bearer ${SECRET}` }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.accepted).toBe(1)
		expect(sessionManager.appendRemoteSessionLogs).toHaveBeenCalledWith(sessionId, [
			{ stream: 'stdout', content: 'a normal line' },
		])
		expect(warnSpy).toHaveBeenCalledWith(
			'Rejected oversized log line(s) in remote session log batch',
			expect.objectContaining({ sessionId, rejectedCount: 1, acceptedCount: 1 }),
		)
	})

	it('returns 400 and logs the validation detail when every line in the batch is too large', async () => {
		const { app, sessionManager } = createSessionTestApp(
			agentServerReconcileRoutes,
			'/api/internal/agent-servers',
		)
		sessionManager.appendRemoteSessionLogs = vi.fn().mockResolvedValue(undefined)
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

		const tooLarge = 'x'.repeat(1_100_000)
		const res = await app.request(
			jsonRequest(
				'POST',
				logsPath(),
				{ logs: [{ stream: 'stdout', content: tooLarge }] },
				{ Authorization: `Bearer ${SECRET}` },
			),
		)

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.code).toBe('VALIDATION_ERROR')
		expect(sessionManager.appendRemoteSessionLogs).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith(
			'Rejected oversized log line(s) in remote session log batch',
			expect.objectContaining({ sessionId, rejectedCount: 1, acceptedCount: 0 }),
		)
	})

	it('returns 500 instead of a false-success 200 when persisting the batch fails', async () => {
		// Regression coverage: this route used to catch appendRemoteSessionLogs
		// errors and still return 200 with `accepted: validLogs.length` — the
		// agent-server's flushLogs() reads that as full success and discards
		// the batch forever, even though nothing (or only part of it) actually
		// reached session_logs. A DB failure must surface as a non-2xx so the
		// client's existing retry logic re-sends the batch instead of silently
		// losing it.
		const { app, sessionManager } = createSessionTestApp(
			agentServerReconcileRoutes,
			'/api/internal/agent-servers',
		)
		sessionManager.appendRemoteSessionLogs = vi.fn().mockRejectedValue(new Error('db down'))
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})

		const logs = [{ stream: 'stdout', content: 'a normal line' }]
		const res = await app.request(
			jsonRequest('POST', logsPath(), { logs }, { Authorization: `Bearer ${SECRET}` }),
		)

		expect(res.status).toBe(500)
		const body = await res.json()
		expect(body.error.code).toBe('INTERNAL_ERROR')
		expect(errorSpy).toHaveBeenCalledWith(
			'Failed to append remote session logs',
			expect.objectContaining({ sessionId, error: expect.stringContaining('db down') }),
		)
	})

	it('returns 401 when the Authorization header is missing', async () => {
		const { app } = createSessionTestApp(agentServerReconcileRoutes, '/api/internal/agent-servers')

		const res = await app.request(
			jsonRequest('POST', logsPath(), { logs: [{ stream: 'stdout', content: 'hi' }] }),
		)

		expect(res.status).toBe(401)
	})
})
