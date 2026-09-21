import { events, actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { detachProviderMcpServers } from '../../lib/integrations/mcp-detach'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Disconnecting an integration must also strip the MCP server agents copied
 * into `actors.tools.mcpServers`. Left attached, the agent boots with the
 * server configured and every tool call fails — it reports a broken platform
 * rather than a missing connection.
 *
 * Real Postgres rather than a mocked db: the read is a join across
 * `workspace_members`, and the write is a jsonb round-trip. A mock would
 * assert the shape of calls this file makes, not that the row comes back
 * changed.
 */

const LINKEDIN_MCP = {
	type: 'http',
	url: '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp',
	headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
}
const MASKIN_MCP = {
	type: 'http',
	url: '${MASKIN_API_URL}/mcp',
	headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
}

async function insertAgent(workspaceId: string, tools: unknown) {
	const [agent] = await db
		.insert(actors)
		.values({ type: 'agent', name: 'Chief of Staff', apiKey: `ank_${crypto.randomUUID()}`, tools })
		.returning()
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

async function toolsOf(actorId: string) {
	const [row] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
	return (row?.tools ?? {}) as { mcpServers?: Record<string, unknown> }
}

describe('detachProviderMcpServers', () => {
	it('removes the provider entry and leaves every other server intact', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const agent = await insertAgent(ws.id, {
			mcpServers: { maskin: MASKIN_MCP, 'linkedin-unipile': LINKEDIN_MCP },
		})

		const changed = await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)

		expect(changed).toBe(1)
		const tools = await toolsOf(agent.id)
		expect(Object.keys(tools.mcpServers ?? {})).toEqual(['maskin'])
	})

	// The key is user-editable; the URL is what decides where calls go.
	it('removes a renamed entry that still points at the provider endpoint', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const agent = await insertAgent(ws.id, {
			mcpServers: { 'my-linkedin': LINKEDIN_MCP, maskin: MASKIN_MCP },
		})

		await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)

		expect(Object.keys((await toolsOf(agent.id)).mcpServers ?? {})).toEqual(['maskin'])
	})

	// The mirror case: a hand-written server that merely shares the name must
	// survive, or disconnecting one provider silently deletes someone's own
	// unrelated config.
	it('leaves a same-named server pointing somewhere else alone', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const agent = await insertAgent(ws.id, {
			mcpServers: {
				'linkedin-unipile': { type: 'http', url: 'https://example.com/my-own/mcp' },
			},
		})

		const changed = await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)

		expect(changed).toBe(0)
		expect(Object.keys((await toolsOf(agent.id)).mcpServers ?? {})).toEqual(['linkedin-unipile'])
	})

	it('does not touch agents in another workspace', async () => {
		const createdBy = getTestActorId()
		const wsA = await insertWorkspace(db, createdBy)
		const wsB = await insertWorkspace(db, createdBy)
		const agentB = await insertAgent(wsB.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })

		await detachProviderMcpServers(db, wsA.id, 'linkedin-unipile', createdBy)

		expect(Object.keys((await toolsOf(agentB.id)).mcpServers ?? {})).toEqual(['linkedin-unipile'])
	})

	it('writes an audit event naming what was detached', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const agent = await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })

		await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)

		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityId, agent.id)))
		expect(rows).toHaveLength(1)
		expect(rows[0].data).toMatchObject({
			mcp_servers_detached: ['linkedin-unipile'],
			reason: 'integration_disconnected',
		})
	})

	it('is a no-op for an agent with no MCP servers at all', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		await insertAgent(ws.id, null)

		expect(await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)).toBe(0)
	})

	// Humans hold API keys too, but they don't run sessions off `tools` — only
	// agents should be rewritten.
	it('ignores human members', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const human = await insertActor(db)
		await db
			.update(actors)
			.set({ tools: { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } } })
			.where(eq(actors.id, human.id))
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: human.id, role: 'member' })

		expect(await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)).toBe(0)
		expect(Object.keys((await toolsOf(human.id)).mcpServers ?? {})).toEqual(['linkedin-unipile'])
	})

	it('detaches from every agent in the workspace, not just the first', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		const a = await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })
		const b = await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })

		expect(await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)).toBe(2)
		expect((await toolsOf(a.id)).mcpServers).toEqual({})
		expect((await toolsOf(b.id)).mcpServers).toEqual({})
	})

	it('leaves the integrations table alone — it only rewrites agent config', async () => {
		const createdBy = getTestActorId()
		const ws = await insertWorkspace(db, createdBy)
		await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'linkedin-unipile',
			status: 'revoked',
			credentials: 'x',
			createdBy,
		})

		await detachProviderMcpServers(db, ws.id, 'linkedin-unipile', createdBy)

		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('revoked')
	})
})
