import { integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { encrypt } from '../../lib/crypto'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertAgentGrant, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Launching a session in a workspace with two Gmail accounts connected, against real Postgres:
 * which Gmail servers an agent gets depends on the access it holds on each account.
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

type Level = 'read' | 'read_write' | 'none'

async function launch(levels: { first: Level; second: Level }) {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	// The second account is inserted first on purpose: age decides which is "the first", not insertion order.
	const rows: Record<'first' | 'second', typeof integrations.$inferSelect> = {} as never
	for (const [name, externalId, createdAt] of [
		['second', 'krumhausen@gmail.com', new Date('2026-02-01')],
		['first', 'sebastian@meshfirm.com', new Date('2026-01-01')],
	] as const) {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'gmail',
				status: 'active',
				externalId,
				credentials: encrypt(
					JSON.stringify({ accessToken: `token-${name}`, expiresAt: Date.now() + 3_600_000 }),
				),
				createdBy: human,
				createdAt,
				defaultAgentAccess: 'none',
			})
			.returning()
		if (!row) throw new Error('integration was not inserted')
		rows[name] = row
		if (levels[name] !== 'none') {
			await insertAgentGrant(db, {
				workspaceId: ws.id,
				integrationId: row.id,
				actorId: agent.id,
				access: levels[name],
			})
		}
	}
	const created = await insertSession(db, ws.id, agent.id, human, {
		status: 'pending',
		containerId: null,
	})
	const [session] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		const env = (await manager.buildLaunchSpec(session as typeof sessions.$inferSelect)).env
		const servers = (
			JSON.parse(env.MCP_SERVERS_JSON ?? '{"mcpServers":{}}') as {
				mcpServers: Record<string, { url?: string }>
			}
		).mcpServers
		const gmail = Object.fromEntries(
			Object.entries(servers).filter(([key]) => key.startsWith('integration-gmail')),
		)
		return { env, gmail, rows }
	} finally {
		await manager.stop()
	}
}

describe('Launching a session with two Gmail accounts connected (Integration)', () => {
	it('gives an agent with access to both one server each, named by address', async () => {
		const { gmail, rows, env } = await launch({ first: 'read', second: 'read' })

		expect(Object.keys(gmail).sort()).toEqual([
			'integration-gmail-krumhausen-gmail-com',
			'integration-gmail-sebastian-meshfirm-com',
		])
		expect(gmail['integration-gmail-sebastian-meshfirm-com']?.url).toBe(
			`\${MASKIN_API_URL}/api/integrations/gmail/gateway/${rows.first.id}`,
		)
		expect(gmail['integration-gmail-krumhausen-gmail-com']?.url).toBe(
			`\${MASKIN_API_URL}/api/integrations/gmail/gateway/${rows.second.id}`,
		)
		// The tokens stay on the server.
		expect(JSON.stringify(env)).not.toContain('token-first')
		expect(JSON.stringify(env)).not.toContain('token-second')
	})

	it('keeps the old key and the plain address for an agent with the first account only', async () => {
		const { gmail } = await launch({ first: 'read', second: 'none' })

		expect(Object.keys(gmail)).toEqual(['integration-gmail'])
		expect(gmail['integration-gmail']?.url).toBe('${MASKIN_API_URL}/api/integrations/gmail/gateway')
	})

	it('points the old key at the one account an agent has when that is the newer one', async () => {
		const { gmail, rows } = await launch({ first: 'none', second: 'read_write' })

		expect(Object.keys(gmail)).toEqual(['integration-gmail'])
		expect(gmail['integration-gmail']?.url).toBe(
			`\${MASKIN_API_URL}/api/integrations/gmail/gateway/${rows.second.id}`,
		)
	})

	it('gives an agent with no access to either account no Gmail server', async () => {
		const { gmail } = await launch({ first: 'none', second: 'none' })

		expect(gmail).toEqual({})
	})
})
