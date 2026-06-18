import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

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
