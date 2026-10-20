import { events, actors, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	type DetachedIntegration,
	detachProviderMcpServers,
} from '../../lib/integrations/mcp-detach'
import { insertActor, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: integrationsRoutes } = await import('../../routes/integrations')

/**
 * Disconnecting an integration must also strip the MCP server agents copied
 * into `actors.tools.mcpServers`. Left attached, the agent boots with the
 * server configured and every tool call fails — it reports a broken platform
 * rather than a missing connection.
 *
 * What counts as a provider's entry is declared in its own config.ts and
 * applied for every provider by `mcp-detach.ts`. A workspace can hold several
 * active rows per provider (the unique index is on workspace, actor, provider
 * and external id), so disconnecting one must leave what another still needs.
 *
 * Real Postgres rather than a mocked db: the read is a join across
 * `workspace_members`, the "is another connection still active" decision is a
 * read of `integrations`, and the write is a jsonb round-trip. A mock would
 * assert the shape of calls this file makes, not that the row comes back
 * changed.
 */

const MASKIN_API = '${MASKIN_API_URL}'
const API_HEADERS = {
	Authorization: 'Bearer ${MASKIN_API_KEY}',
	'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
}
const LINKEDIN_MCP = {
	type: 'http',
	url: `${MASKIN_API}/api/integrations/linkedin-unipile/mcp`,
	headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
}
const SLACK_MCP = {
	type: 'http',
	url: `${MASKIN_API}/api/integrations/slack/mcp`,
	headers: API_HEADERS,
}
const MEET_MCP = {
	type: 'http',
	url: `${MASKIN_API}/api/integrations/google-meet/mcp`,
	headers: API_HEADERS,
}
const LINEAR_MCP = {
	type: 'http',
	url: 'https://mcp.linear.app/mcp',
	headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
}
const MASKIN_MCP = {
	type: 'http',
	url: `${MASKIN_API}/mcp`,
	headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
}
const githubEntry = (envKey: string) => ({
	type: 'stdio',
	command: 'npx',
	args: ['-y', '@modelcontextprotocol/server-github'],
	env: { GITHUB_PERSONAL_ACCESS_TOKEN: `\${GITHUB_TOKEN_${envKey}}` },
})

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

async function serverKeys(actorId: string) {
	return Object.keys((await toolsOf(actorId)).mcpServers ?? {}).sort()
}

async function connect(
	workspaceId: string,
	provider: string,
	extra: Partial<typeof integrations.$inferInsert> = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status: 'active',
			// Distinct per row: a workspace-scoped provider's rows collide on
			// (workspace, provider, external id) otherwise.
			externalId: crypto.randomUUID(),
			credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-test' })),
			createdBy: getTestActorId(),
			...extra,
		})
		.returning()
	return row
}

/** Mirrors the DELETE route: the row is revoked first, then detach runs. */
async function disconnect(row: DetachedIntegration) {
	await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, row.id))
	return detachProviderMcpServers(db, row, getTestActorId())
}

describe('detachProviderMcpServers', () => {
	it('removes the provider entry and leaves every other server intact', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id, {
			mcpServers: { maskin: MASKIN_MCP, 'linkedin-unipile': LINKEDIN_MCP },
		})
		const row = await connect(ws.id, 'linkedin-unipile')

		const changed = await disconnect(row)

		expect(changed).toBe(1)
		expect(await serverKeys(agent.id)).toEqual(['maskin'])
	})

	// The key is user-editable; the URL is what decides where calls go.
	it('removes a renamed entry that still points at the provider endpoint', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id, {
			mcpServers: { 'my-linkedin': LINKEDIN_MCP, maskin: MASKIN_MCP },
		})

		await disconnect(await connect(ws.id, 'linkedin-unipile'))

		expect(await serverKeys(agent.id)).toEqual(['maskin'])
	})

	// The mirror case: a hand-written server that merely shares the name must
	// survive, or disconnecting one provider silently deletes someone's own
	// unrelated config.
	it('leaves a same-named server pointing somewhere else alone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id, {
			mcpServers: { 'linkedin-unipile': { type: 'http', url: 'https://example.com/my-own/mcp' } },
		})

		const changed = await disconnect(await connect(ws.id, 'linkedin-unipile'))

		expect(changed).toBe(0)
		expect(await serverKeys(agent.id)).toEqual(['linkedin-unipile'])
	})

	it('does not touch agents in another workspace', async () => {
		const wsA = await insertWorkspace(db, getTestActorId())
		const wsB = await insertWorkspace(db, getTestActorId())
		const agentB = await insertAgent(wsB.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })

		await disconnect(await connect(wsA.id, 'linkedin-unipile'))

		expect(await serverKeys(agentB.id)).toEqual(['linkedin-unipile'])
	})

	it('writes an audit event naming what was detached', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })

		await disconnect(await connect(ws.id, 'linkedin-unipile'))

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
		const ws = await insertWorkspace(db, getTestActorId())
		await insertAgent(ws.id, null)

		expect(await disconnect(await connect(ws.id, 'linkedin-unipile'))).toBe(0)
	})

	// Humans hold API keys too, but they don't run sessions off `tools` — only
	// agents should be rewritten.
	it('ignores human members', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const human = await insertActor(db)
		await db
			.update(actors)
			.set({ tools: { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } } })
			.where(eq(actors.id, human.id))
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: human.id, role: 'member' })

		expect(await disconnect(await connect(ws.id, 'linkedin-unipile'))).toBe(0)
		expect(await serverKeys(human.id)).toEqual(['linkedin-unipile'])
	})

	it('detaches from every agent in the workspace, not just the first', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const a = await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })
		const b = await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })

		expect(await disconnect(await connect(ws.id, 'linkedin-unipile'))).toBe(2)
		expect((await toolsOf(a.id)).mcpServers).toEqual({})
		expect((await toolsOf(b.id)).mcpServers).toEqual({})
	})

	it('leaves the integrations table alone — it only rewrites agent config', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await insertAgent(ws.id, { mcpServers: { 'linkedin-unipile': LINKEDIN_MCP } })
		const row = await connect(ws.id, 'linkedin-unipile')

		await disconnect(row)

		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows).toHaveLength(1)
		expect(rows[0].status).toBe('revoked')
	})

	// 14 Oct 2026: disconnecting Magnus's LinkedIn stripped Sebastian's entry from
	// eight agents too, because the bare `/mcp` prefix matches every identity.
	describe('LinkedIn: one endpoint per identity', () => {
		const instance = (slug: string) => ({
			type: 'http',
			url: `${MASKIN_API}/api/integrations/linkedin-unipile/mcp/${slug}`,
		})
		const SEBK = 'linkedin-krumhausen-personal'
		const MAGNUS = 'linkedin-magnus-noeddegaard-personal'

		it('removes only the disconnected identity and keeps the other', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: { maskin: MASKIN_MCP, [SEBK]: instance(SEBK), [MAGNUS]: instance(MAGNUS) },
			})
			await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: 'krumhausen' })
			const magnus = await connect(ws.id, 'linkedin-unipile', {
				unipileAccSlug: 'magnus-noeddegaard',
			})

			await disconnect(magnus)

			expect(await serverKeys(agent.id)).toEqual(['maskin', SEBK].sort())
		})

		it('does not report an agent that only holds other identities as changed', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, { mcpServers: { [SEBK]: instance(SEBK) } })
			await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: 'krumhausen' })
			const magnus = await connect(ws.id, 'linkedin-unipile', {
				unipileAccSlug: 'magnus-noeddegaard',
			})

			expect(await disconnect(magnus)).toBe(0)
			expect(await serverKeys(agent.id)).toEqual([SEBK])
		})

		// `linkedin-magnus-` is a string prefix of `linkedin-magnus-noeddegaard-personal`.
		it('leaves a longer-slug credential alone when its prefix extends the disconnected one', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: {
					'linkedin-magnus-personal': instance('linkedin-magnus-personal'),
					[MAGNUS]: instance(MAGNUS),
				},
			})
			const short = await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: 'magnus' })
			await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: 'magnus-noeddegaard' })

			await disconnect(short)

			expect(await serverKeys(agent.id)).toEqual([MAGNUS])
		})

		it('still removes the deprecated bare aggregate entry', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: { 'linkedin-unipile': LINKEDIN_MCP, [SEBK]: instance(SEBK) },
			})
			await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: 'krumhausen' })
			const magnus = await connect(ws.id, 'linkedin-unipile', {
				unipileAccSlug: 'magnus-noeddegaard',
			})

			await disconnect(magnus)

			expect(await serverKeys(agent.id)).toEqual([SEBK])
		})

		it('removes nothing but the aggregate when the credential never enumerated an identity', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, { mcpServers: { [SEBK]: instance(SEBK) } })
			const bare = await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: null })

			expect(await disconnect(bare)).toBe(0)
			expect(await serverKeys(agent.id)).toEqual([SEBK])
		})

		it('counts only active credentials as ones whose entries must stay', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: { 'linkedin-magnus-personal': instance('linkedin-magnus-personal') },
			})
			await connect(ws.id, 'linkedin-unipile', {
				unipileAccSlug: 'magnus-noeddegaard',
				status: 'revoked',
			})
			const short = await connect(ws.id, 'linkedin-unipile', { unipileAccSlug: 'magnus' })

			await disconnect(short)

			expect(await serverKeys(agent.id)).toEqual([])
		})
	})

	// Slack serves ONE shared entry however many teams are connected, so a second
	// connection (a different Slack team, hence a different external id) still
	// needs the entry the first one's disconnect would otherwise strip.
	describe('Slack: one shared entry for every connection', () => {
		it('keeps the entry while another Slack connection is active', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, { mcpServers: { slack: SLACK_MCP } })
			const first = await connect(ws.id, 'slack')
			await connect(ws.id, 'slack')

			expect(await disconnect(first)).toBe(0)
			expect(await serverKeys(agent.id)).toEqual(['slack'])
		})

		it('removes the entry when the last active Slack connection goes', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: { slack: SLACK_MCP, maskin: MASKIN_MCP },
			})
			const first = await connect(ws.id, 'slack')
			const second = await connect(ws.id, 'slack')

			await disconnect(first)
			expect(await disconnect(second)).toBe(1)
			expect(await serverKeys(agent.id)).toEqual(['maskin'])
		})

		it('does not let a revoked sibling keep the entry alive', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, { mcpServers: { slack: SLACK_MCP } })
			await connect(ws.id, 'slack', { status: 'revoked' })
			const live = await connect(ws.id, 'slack')

			await disconnect(live)

			expect(await serverKeys(agent.id)).toEqual([])
		})

		it('does not let another provider keep the entry alive', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, { mcpServers: { slack: SLACK_MCP } })
			await connect(ws.id, 'linear')
			const slack = await connect(ws.id, 'slack')

			await disconnect(slack)

			expect(await serverKeys(agent.id)).toEqual([])
		})
	})

	// Providers whose server is hosted elsewhere never matched the old URL test
	// (it only knew this API's own /mcp paths), so disconnect left a dead entry on
	// every agent. They are recognised by the url the config declares AND the
	// token variable it authenticates with.
	describe('providers whose MCP server is hosted elsewhere', () => {
		it('removes the Linear entry the config declares', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: { linear: LINEAR_MCP, maskin: MASKIN_MCP },
			})

			await disconnect(await connect(ws.id, 'linear'))

			expect(await serverKeys(agent.id)).toEqual(['maskin'])
		})

		it('leaves a hand-written server on the same url that uses its own key', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const own = {
				type: 'http',
				url: 'https://mcp.linear.app/mcp',
				headers: { Authorization: 'Bearer lin_api_x' },
			}
			const agent = await insertAgent(ws.id, { mcpServers: { 'my-linear': own } })

			expect(await disconnect(await connect(ws.id, 'linear'))).toBe(0)
			expect(await serverKeys(agent.id)).toEqual(['my-linear'])
		})

		it('removes the Google Meet entry this API serves', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, { mcpServers: { 'google-meet': MEET_MCP } })

			await disconnect(await connect(ws.id, 'google-meet'))

			expect(await serverKeys(agent.id)).toEqual([])
		})
	})

	// GitHub writes one stdio entry per installation whose token is
	// ${GITHUB_TOKEN_<OWNER>}: no URL to match, so it is matched on that variable.
	describe('GitHub: one stdio entry per installation', () => {
		it('removes only the disconnected installation', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: {
					'github-sindre-ai': githubEntry('SINDRE_AI'),
					'github-vaerksted-ai': githubEntry('VAERKSTED_AI'),
				},
			})
			const sindre = await connect(ws.id, 'github', { config: { owner_login: 'sindre-ai' } })
			await connect(ws.id, 'github', { config: { owner_login: 'vaerksted-ai' } })

			expect(await disconnect(sindre)).toBe(1)
			expect(await serverKeys(agent.id)).toEqual(['github-vaerksted-ai'])
		})

		it('removes nothing when the row names no owner', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertAgent(ws.id, {
				mcpServers: { 'github-sindre-ai': githubEntry('SINDRE_AI') },
			})

			expect(await disconnect(await connect(ws.id, 'github'))).toBe(0)
			expect(await serverKeys(agent.id)).toEqual(['github-sindre-ai'])
		})
	})
})

// The same decision, driven through the route a user actually hits.
describe('DELETE /api/integrations/:id detaches per connection', () => {
	it('keeps the Slack entry for the second team and drops it with the last', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertAgent(ws.id, { mcpServers: { slack: SLACK_MCP } })
		const first = await connect(ws.id, 'slack')
		const second = await connect(ws.id, 'slack')
		const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
		const remove = (id: string) =>
			app.request(
				new Request(`http://localhost/api/integrations/${id}`, {
					method: 'DELETE',
					headers: { 'X-Workspace-Id': ws.id },
				}),
			)

		expect((await remove(first.id)).status).toBe(200)
		expect(await serverKeys(agent.id)).toEqual(['slack'])

		expect((await remove(second.id)).status).toBe(200)
		expect(await serverKeys(agent.id)).toEqual([])
	})
})
