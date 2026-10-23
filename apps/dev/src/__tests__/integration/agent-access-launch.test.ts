import { integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

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

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const reader = await insertActor(db, { type: 'agent', systemPrompt: 'Reader agent' })
	const writer = await insertActor(db, { type: 'agent', systemPrompt: 'Writer agent' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: reader.id, role: 'member' },
		{ workspaceId: ws.id, actorId: writer.id, role: 'member' },
	])
	const slack = (
		await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'slack',
				status: 'active',
				credentials: 'x',
				createdBy: human,
			})
			.returning()
	)[0]
	await insertAgentGrant(db, {
		workspaceId: ws.id,
		integrationId: slack.id,
		actorId: writer.id,
		access: 'read_write',
	})
	return { human, ws, reader, writer, slack }
}

async function promptFor(s: Awaited<ReturnType<typeof setup>>, actorId: string) {
	const created = await insertSession(db, s.ws.id, actorId, s.human, {
		status: 'pending',
		containerId: null,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		const spec = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
		return spec.env.SYSTEM_PROMPT ?? ''
	} finally {
		await manager.stop()
	}
}

describe('Agent access in the launch system prompt (Integration)', () => {
	it('tells each agent its own level on a connected integration, before it tries anything', async () => {
		const s = await setup()
		const readerPrompt = await promptFor(s, s.reader.id)
		const writerPrompt = await promptFor(s, s.writer.id)

		expect(readerPrompt).toContain('## Integration access')
		expect(readerPrompt).toContain('- Slack: Read (read tools only')
		expect(writerPrompt).toMatch(/- Slack: Read & write/)
		// The agent's own prompt and the access block both survive.
		expect(readerPrompt).toContain('Reader agent')
		expect(readerPrompt.indexOf('Reader agent')).toBeLessThan(
			readerPrompt.indexOf('## Integration access'),
		)
	})

	it('follows a change made after the first launch', async () => {
		const s = await setup()
		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, s.slack.id))
		expect(await promptFor(s, s.reader.id)).toMatch(/- Slack: No access/)
		// The explicit grant still wins over a restricted default.
		expect(await promptFor(s, s.writer.id)).toMatch(/- Slack: Read & write/)
	})

	it('adds nothing for a workspace with no connected integration', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human, {
			enterpriseGranted: true,
			settings: { llm_keys: { anthropic: 'sk-ant-test' } },
		})
		const agent = await insertActor(db, { type: 'agent', systemPrompt: 'Lonely agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
		const created = await insertSession(db, ws.id, agent.id, human, {
			status: 'pending',
			containerId: null,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
		const manager = new SessionManager(db, stubStorage())
		try {
			const spec = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
			expect(spec.env.SYSTEM_PROMPT).not.toContain('Integration access')
		} finally {
			await manager.stop()
		}
	})
})
