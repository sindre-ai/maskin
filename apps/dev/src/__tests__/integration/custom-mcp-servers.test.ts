import { OpenAPIHono } from '@hono/zod-openapi'
import {
	events,
	actors,
	agentGrants,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { decrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import { describeAgentAccess } from '../../lib/integrations/agent-access-view'
import { MASKED_VALUE, readCustomServer } from '../../lib/integrations/custom-mcp'
import { migrateAgentToolServers } from '../../lib/integrations/migrate-agent-tool-servers'
import customMcpServersRoutes from '../../routes/custom-mcp-servers'
import integrationsGrantsRoutes from '../../routes/integrations-grants'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY ??= 'a'.repeat(64)
})

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
	app.route('/api/custom-mcp-servers', customMcpServersRoutes)
	app.route('/api/integrations', integrationsGrantsRoutes)
	return app
}

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

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agentA = await insertActor(db, { type: 'agent', name: 'Agent A' })
	const agentB = await insertActor(db, { type: 'agent', name: 'Agent B' })
	for (const a of [agentA, agentB]) {
		await db.insert(workspaceMembers).values({ workspaceId: ws.id, actorId: a.id, role: 'member' })
	}
	return { human, ws, agentA, agentB, app: appFor(human) }
}
type Setup = Awaited<ReturnType<typeof setup>>

function call(s: Setup, method: string, path: string, body?: unknown) {
	return s.app.request(path, {
		method,
		headers: { 'X-Workspace-Id': s.ws.id, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const LINEAR_LIKE = {
	type: 'http' as const,
	url: 'https://tools.example.com/mcp',
	headers: { Authorization: 'Bearer sk-live-secret-value' },
}

async function addServer(s: Setup, name = 'Docs search', server: object = LINEAR_LIKE) {
	const res = await call(s, 'POST', '/api/custom-mcp-servers', { name, server })
	return { res, body: (await res.json()) as { id: string } }
}

async function mcpServersFor(s: Setup, agentId: string): Promise<Record<string, unknown>> {
	const created = await insertSession(db, s.ws.id, agentId, s.human, {
		status: 'pending',
		containerId: null,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		const spec = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
		return JSON.parse(spec.env.MCP_SERVERS_JSON ?? '{}').mcpServers ?? {}
	} finally {
		await manager.stop()
	}
}

describe('Custom MCP servers (Integration)', () => {
	it('stores the definition encrypted, shows members only a summary, and audits it', async () => {
		const s = await setup()
		const { res, body } = await addServer(s)
		expect(res.status).toBe(201)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, body.id))
		expect(row.provider).toBe('custom-mcp')
		expect(row.defaultAgentAccess).toBe('none')
		expect(row.credentials).not.toContain('sk-live-secret-value')
		expect(JSON.stringify(row.config)).not.toContain('sk-live-secret-value')
		expect(JSON.parse(decrypt(row.credentials as string)).server.headers.Authorization).toBe(
			'Bearer sk-live-secret-value',
		)

		const read = (await (await call(s, 'GET', `/api/custom-mcp-servers/${body.id}`)).json()) as {
			server: { headers: Record<string, string> }
		}
		expect(read.server.headers.Authorization).toBe(MASKED_VALUE)

		const [event] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, body.id), eq(events.action, 'created')))
		expect(event).toBeDefined()
	})

	it('rejects a duplicate name, a bad URL, and an agent as the caller', async () => {
		const s = await setup()
		await addServer(s)
		expect((await addServer(s, 'docs SEARCH')).res.status).toBe(409)
		expect((await addServer(s, 'Other', { type: 'http', url: 'ftp://x' })).res.status).toBe(400)
		const asAgent = appFor(s.agentA.id, 'agent')
		const res = await asAgent.request('/api/custom-mcp-servers', {
			method: 'POST',
			headers: { 'X-Workspace-Id': s.ws.id, 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Mine', server: LINEAR_LIKE }),
		})
		expect(res.status).toBe(403)
	})

	it('keeps a masked secret on edit, but not when the URL changes', async () => {
		const s = await setup()
		const { body } = await addServer(s)
		const masked = { ...LINEAR_LIKE, headers: { Authorization: MASKED_VALUE } }

		const keep = await call(s, 'PUT', `/api/custom-mcp-servers/${body.id}`, {
			name: 'Docs search',
			server: { ...masked, url: 'https://tools.example.com/mcp' },
		})
		expect(keep.status).toBe(200)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, body.id))
		expect(readCustomServer(row)?.headers?.Authorization).toBe('Bearer sk-live-secret-value')

		const redirected = await call(s, 'PUT', `/api/custom-mcp-servers/${body.id}`, {
			name: 'Docs search',
			server: { ...masked, url: 'https://evil.example.com/mcp' },
		})
		expect(redirected.status).toBe(400)
		const [after] = await db.select().from(integrations).where(eq(integrations.id, body.id))
		expect(readCustomServer(after)?.url).toBe('https://tools.example.com/mcp')
	})

	it('is on or off for an agent: read_write or none, never read', async () => {
		const s = await setup()
		const { body } = await addServer(s)
		const put = (actorId: string, access: string) =>
			call(s, 'PUT', `/api/integrations/${body.id}/grants/${actorId}`, { access })
		expect((await put(s.agentA.id, 'read')).status).toBe(400)
		expect((await put(s.agentA.id, 'read_write')).status).toBe(200)
		expect((await put(s.agentB.id, 'none')).status).toBe(200)
	})

	it('attaches a server only to agents with access, and the Maskin MCP to every agent', async () => {
		const s = await setup()
		const { body } = await addServer(s)
		await call(s, 'PUT', `/api/integrations/${body.id}/grants/${s.agentA.id}`, {
			access: 'read_write',
		})

		const a = await mcpServersFor(s, s.agentA.id)
		const b = await mcpServersFor(s, s.agentB.id)
		const customKeys = (m: Record<string, unknown>) =>
			Object.keys(m).filter((k) => k.startsWith('custom-'))

		expect(customKeys(a)).toHaveLength(1)
		expect((a[customKeys(a)[0] as string] as { url: string }).url).toBe(LINEAR_LIKE.url)
		expect(customKeys(b)).toEqual([])
		expect(a.maskin).toBeDefined()
		expect(b.maskin).toBeDefined()

		// Turning it on for every agent reaches B; B can still be taken off.
		await call(s, 'PUT', `/api/integrations/${body.id}/default-access`, {
			defaultAgentAccess: 'read',
		})
		expect(customKeys(await mcpServersFor(s, s.agentB.id))).toHaveLength(1)
		await call(s, 'PUT', `/api/integrations/${body.id}/grants/${s.agentB.id}`, { access: 'none' })
		expect(customKeys(await mcpServersFor(s, s.agentB.id))).toEqual([])
	})

	it('does not add a second Maskin MCP when the agent already lists it', async () => {
		const s = await setup()
		await db
			.update(actors)
			.set({
				tools: {
					mcpServers: {
						maskin: {
							type: 'http',
							url: '${MASKIN_API_URL}/mcp',
							headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
						},
					},
				},
			})
			.where(eq(actors.id, s.agentA.id))
		const created = await insertSession(db, s.ws.id, s.agentA.id, s.human, {
			status: 'pending',
			containerId: null,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
		const manager = new SessionManager(db, stubStorage())
		try {
			const spec = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
			expect(JSON.parse(spec.env.MCP_SERVERS_JSON ?? '{}').mcpServers?.maskin).toBeUndefined()
			expect(JSON.parse(spec.env.AGENT_MCP_JSON ?? '{}').mcpServers.maskin).toBeDefined()
		} finally {
			await manager.stop()
		}
	})

	it('reports the locked Maskin MCP and the server as a tool server in the agent view', async () => {
		const s = await setup()
		const { body } = await addServer(s)
		await call(s, 'PUT', `/api/integrations/${body.id}/grants/${s.agentA.id}`, {
			access: 'read_write',
		})
		const view = await describeAgentAccess(db, s.ws.id, s.agentA.id)
		expect(view.maskin_mcp).toEqual({ name: 'Maskin', access: 'read_write', locked: true })
		const row = view.integrations.find((i) => i.integration_id === body.id)
		expect(row).toMatchObject({
			kind: 'tool_server',
			name: 'Docs search',
			access: 'read_write',
			server_attached: true,
		})
	})
})

describe('Moving agent tool servers to the workspace (Integration)', () => {
	const shared = { type: 'http', url: 'https://tools.example.com/mcp', headers: { 'X-Key': 'k1' } }

	it('turns the same server on two agents into one row with two grants, and is idempotent', async () => {
		const s = await setup()
		const slack = { type: 'http', url: '${MASKIN_API_URL}/api/integrations/slack/mcp' }
		const maskin = { type: 'http', url: '${MASKIN_API_URL}/mcp' }
		for (const agent of [s.agentA, s.agentB]) {
			await db
				.update(actors)
				.set({ tools: { mcpServers: { docs: shared, slack, maskin } } })
				.where(eq(actors.id, agent.id))
		}

		const first = await migrateAgentToolServers(db)
		expect(first.agents).toBeGreaterThanOrEqual(2)

		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, s.ws.id), eq(integrations.provider, 'custom-mcp')))
		expect(rows).toHaveLength(1)
		expect(rows[0].displayName).toBe('docs')
		expect(readCustomServer(rows[0])?.headers).toEqual({ 'X-Key': 'k1' })
		const grants = await db
			.select()
			.from(agentGrants)
			.where(eq(agentGrants.integrationId, rows[0].id))
		expect(grants.map((g) => g.actorId).sort()).toEqual([s.agentA.id, s.agentB.id].sort())
		expect(grants.every((g) => g.access === 'read_write')).toBe(true)

		// The integration-bound entries stay; the moved one is gone from the agent.
		const [after] = await db.select().from(actors).where(eq(actors.id, s.agentA.id))
		expect(Object.keys((after.tools as { mcpServers: object }).mcpServers).sort()).toEqual([
			'maskin',
			'slack',
		])

		await migrateAgentToolServers(db)
		const again = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, s.ws.id), eq(integrations.provider, 'custom-mcp')))
		expect(again).toHaveLength(1)
	})

	it('keeps two different servers that share a name as two rows', async () => {
		const s = await setup()
		await db
			.update(actors)
			.set({ tools: { mcpServers: { docs: shared } } })
			.where(eq(actors.id, s.agentA.id))
		await db
			.update(actors)
			.set({ tools: { mcpServers: { docs: { ...shared, url: 'https://other.example.com/mcp' } } } })
			.where(eq(actors.id, s.agentB.id))

		await migrateAgentToolServers(db)
		const rows = await db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, s.ws.id), eq(integrations.provider, 'custom-mcp')))
		expect(rows.map((r) => r.displayName).sort()).toEqual(['docs', 'docs (Agent B)'])
	})
})
