import { integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { encrypt } from '../../lib/crypto'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertAgentGrant, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

const GATEWAY = (provider: string) => `\${MASKIN_API_URL}/api/integrations/${provider}/gateway`

async function setup(connect: Array<{ provider: string; defaultAgentAccess?: 'read' | 'none' }>) {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const rows: Record<string, typeof integrations.$inferSelect> = {}
	for (const c of connect) {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: c.provider,
				status: 'active',
				credentials: encrypt(
					JSON.stringify({
						accessToken:
							c.provider === 'slack'
								? 'xoxb-fake-slack-0123456789'
								: `fake-${c.provider}-token-0123456789`,
					}),
				),
				createdBy: human,
				defaultAgentAccess: c.defaultAgentAccess ?? 'read',
			})
			.returning()
		rows[c.provider] = row
	}
	return { human, ws, rows }
}

async function launchAs(
	s: Awaited<ReturnType<typeof setup>>,
	agent: { id: string },
	_label = '',
): Promise<{ servers: Record<string, { url?: string }>; env: Record<string, string> }> {
	const created = await insertSession(db, s.ws.id, agent.id, s.human, {
		status: 'pending',
		containerId: null,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		const { env } = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
		const session = JSON.parse(env.MCP_SERVERS_JSON ?? '{"mcpServers":{}}') as {
			mcpServers: Record<string, { url?: string }>
		}
		return { servers: session.mcpServers, env }
	} finally {
		await manager.stop()
	}
}

async function newAgent(s: Awaited<ReturnType<typeof setup>>, tools: Record<string, unknown> = {}) {
	const agent = await insertActor(db, { type: 'agent', tools })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: s.ws.id, actorId: agent.id, role: 'member' })
	return agent
}

describe('A grant attaches the integration’s MCP server (Integration)', () => {
	it('attaches every connected integration to an agent with default read, with nothing added by hand', async () => {
		const s = await setup([
			{ provider: 'linear' },
			{ provider: 'ubersuggest' },
			{ provider: 'slack' },
		])
		const agent = await newAgent(s)
		const { servers } = await launchAs(s, agent)

		expect(servers['integration-linear']?.url).toBe(GATEWAY('linear'))
		expect(servers['integration-ubersuggest']?.url).toBe(GATEWAY('ubersuggest'))
		expect(servers['integration-slack']?.url).toBe('${MASKIN_API_URL}/api/integrations/slack/mcp')
	})

	it('keeps the provider tokens of gateway providers out of the container', async () => {
		const s = await setup([{ provider: 'linear' }, { provider: 'ubersuggest' }])
		const { env } = await launchAs(s, await newAgent(s))
		expect(JSON.stringify(env)).not.toContain('fake-linear-token')
		expect(JSON.stringify(env)).not.toContain('fake-ubersuggest-token')
		expect(env.LINEAR_TOKEN).toBeUndefined()
		expect(env.UBERSUGGEST_TOKEN).toBeUndefined()
	})

	it('attaches nothing when the default is none, and attaches it for an agent that is granted', async () => {
		const s = await setup([{ provider: 'linear', defaultAgentAccess: 'none' }])
		const stranger = await newAgent(s)
		const granted = await newAgent(s)
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: s.rows.linear.id,
			actorId: granted.id,
			access: 'read',
		})

		expect((await launchAs(s, stranger)).servers['integration-linear']).toBeUndefined()
		expect((await launchAs(s, granted)).servers['integration-linear']?.url).toBe(GATEWAY('linear'))
	})

	it('follows a change made after the first launch, in both directions', async () => {
		const s = await setup([{ provider: 'linear' }])
		const agent = await newAgent(s)
		expect((await launchAs(s, agent)).servers['integration-linear']).toBeDefined()

		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, s.rows.linear.id))
		expect((await launchAs(s, agent)).servers['integration-linear']).toBeUndefined()

		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: s.rows.linear.id,
			actorId: agent.id,
			access: 'read_write',
		})
		expect((await launchAs(s, agent)).servers['integration-linear']).toBeDefined()
	})

	it('does not add a second copy when the agent already added the same server by hand', async () => {
		const s = await setup([{ provider: 'linear' }])
		const agent = await newAgent(s, {
			mcpServers: {
				linear: {
					type: 'http',
					url: 'https://mcp.linear.app/mcp',
					headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
				},
			},
		})
		const { servers, env } = await launchAs(s, agent)
		const own = JSON.parse(env.AGENT_MCP_JSON ?? '{}') as {
			mcpServers: Record<string, { url?: string }>
		}
		// The agent's own entry is the one that survives, pointed at the gateway.
		expect(own.mcpServers.linear.url).toBe(GATEWAY('linear'))
		expect(servers['integration-linear']).toBeUndefined()
	})

	it('leaves out an integration switched off for agent sessions', async () => {
		const s = await setup([{ provider: 'linear' }])
		await db
			.update(integrations)
			.set({ config: { expose_to_agent_sessions: false } })
			.where(eq(integrations.id, s.rows.linear.id))
		expect((await launchAs(s, await newAgent(s))).servers['integration-linear']).toBeUndefined()
	})
})
