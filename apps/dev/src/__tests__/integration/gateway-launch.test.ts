import { integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { encrypt } from '../../lib/crypto'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const LINEAR_TOKEN = 'fake-linear-token-0123456789'
const POSTHOG_TOKEN = 'fake-posthog-token-0123456789'
const SLACK_TOKEN = 'xoxb-fake-slack-token-0123456789'

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

async function launch() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agent = await insertActor(db, {
		type: 'agent',
		tools: {
			mcpServers: {
				// Added by hand, the way the Quick Add button writes it.
				linear: {
					type: 'http',
					url: 'https://mcp.linear.app/mcp',
					headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
				},
				other: { type: 'http', url: 'https://example.test/mcp' },
			},
		},
	})
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	for (const [provider, accessToken] of [
		['linear', LINEAR_TOKEN],
		['posthog', POSTHOG_TOKEN],
		['slack', SLACK_TOKEN],
	] as const) {
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider,
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken })),
			createdBy: human,
		})
	}
	const created = await insertSession(db, ws.id, agent.id, human, {
		status: 'pending',
		containerId: null,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
	} finally {
		await manager.stop()
	}
}

describe('Launching a session with gateway providers connected (Integration)', () => {
	it('keeps the provider tokens out of the container, in every variable', async () => {
		const env = await launch()
		const everything = JSON.stringify(env)
		expect(everything).not.toContain(LINEAR_TOKEN)
		expect(everything).not.toContain(POSTHOG_TOKEN)
		expect(env.LINEAR_TOKEN).toBeUndefined()
		expect(env.POSTHOG_TOKEN).toBeUndefined()
	})

	it('points the agent’s own Linear entry at the gateway and leaves its other servers alone', async () => {
		const env = await launch()
		const tools = JSON.parse(env.AGENT_MCP_JSON ?? '{}') as {
			mcpServers: Record<string, { url?: string; headers?: Record<string, string> }>
		}
		expect(tools.mcpServers.linear.url).toBe('${MASKIN_API_URL}/api/integrations/linear/gateway')
		expect(tools.mcpServers.linear.headers?.Authorization).toBe('Bearer ${MASKIN_API_KEY}')
		expect(tools.mcpServers.other.url).toBe('https://example.test/mcp')
	})

	it('serves the auto-injected PostHog server through the gateway too', async () => {
		const env = await launch()
		const session = JSON.parse(env.MCP_SERVERS_JSON ?? '{}') as {
			mcpServers: Record<string, { url?: string }>
		}
		expect(session.mcpServers['integration-posthog']?.url).toBe(
			'${MASKIN_API_URL}/api/integrations/posthog/gateway',
		)
	})

	it('does not touch a provider Maskin hosts itself', async () => {
		const env = await launch()
		const session = JSON.parse(env.MCP_SERVERS_JSON ?? '{}') as {
			mcpServers: Record<string, { url?: string }>
		}
		expect(session.mcpServers['integration-slack']?.url).toBe(
			'${MASKIN_API_URL}/api/integrations/slack/mcp',
		)
	})
})
