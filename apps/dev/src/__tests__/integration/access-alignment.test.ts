import { randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import type { Database } from '@maskin/db'
import { conversations, integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')
const { default: grantsRoutes } = await import('../../routes/integrations-grants')
const { default: actorsRoutes } = await import('../../routes/actors')
const { default: integrationsRoutes } = await import('../../routes/integrations')

/**
 * One rule, shown everywhere. A change made through any entry point (a default, a grant, a
 * replace-all, a removal, an Allow on a chat card) must show up identically on every surface:
 * the integration list (Integrations and Keychain pages), the agent's access view (agent page
 * and get_actor), the session's credential list, and what a launched session actually gets
 * (its prompt, its attached MCP server, its environment). If this test fails, two screens or
 * tools disagree about what an agent can do.
 */

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => setKmsProviderForTests(undefined))

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}

function appFor(actorId: string, actorType: 'human' | 'agent') {
	const app = new OpenAPIHono<Env>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', {
			stopSession: vi.fn(async () => {}),
			findConversationSessionAnyActive: vi.fn(async () => null),
		})
		await next()
	})
	app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
	app.route('/api/sessions', sessionsRoutes)
	app.route('/api/integrations', grantsRoutes as never)
	app.route('/api/integrations', integrationsRoutes as never)
	app.route('/api/actors', actorsRoutes as never)
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
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const [conversation] = await db
		.insert(conversations)
		.values({ workspaceId: ws.id, title: 'Chat', createdBy: human })
		.returning()
	const chat = await insertSession(db, ws.id, agent.id, human, {
		interactive: true,
		conversationId: conversation.id,
		status: 'running',
	})
	const [linear] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'linear',
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: 'fake-linear-token-0123456789' })),
			createdBy: human,
		})
		.returning()
	const { integrationId: stripeId } = await createByoApiKey(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'Stripe',
		rawSecret: 'fake-stripe-secret-0123456789abcdef',
	})
	return { human, ws, agent, chat, conversation, linear, stripeId }
}
type Setup = Awaited<ReturnType<typeof setup>>

const H = (s: Setup) => ({ 'X-Workspace-Id': s.ws.id })
const asHuman = (s: Setup) => appFor(s.human, 'human')

type ListRow = {
	id: string
	defaultAgentAccess: unknown
	agentGrants: Array<{ actorId: string }>
	chatGrants: unknown[]
}
type AccessRow = Record<string, unknown> & { integration_id: string }
type AccessView = { integrations: AccessRow[]; credentials: AccessRow[] }

async function json<T = unknown>(res: Response) {
	return (await res.json()) as T
}

/** What a freshly launched session of the agent actually gets. */
async function launch(s: Setup, inChat = false) {
	// Inside the chat: the chat's own session (a chat allows one active session per agent).
	const created = inChat
		? s.chat
		: await insertSession(db, s.ws.id, s.agent.id, s.human, {
				status: 'pending',
				containerId: null,
			})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		const { env } = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
		const mcp = JSON.parse(env.MCP_SERVERS_JSON ?? '{"mcpServers":{}}') as {
			mcpServers: Record<string, unknown>
		}
		return {
			linearAttached: 'integration-linear' in mcp.mcpServers,
			stripeInEnv: 'KEYCHAIN_BYO_APIKEY_STRIPE' in env,
			prompt: env.SYSTEM_PROMPT ?? '',
		}
	} finally {
		await manager.stop()
	}
}

interface Expected {
	/** The agent's level on Linear. */
	linear: 'none' | 'read' | 'read_write'
	linearSource: 'grant' | 'default'
	linearDefault: 'read' | 'none'
	/** true: a grant. 'chat': an Allow for the one chat only. false: none. */
	stripe: boolean | 'chat'
}

const PROMPT_LABEL = {
	none: /- Linear: No access/,
	read: /- Linear: Read \(read tools only/,
	read_write: /- Linear: Read & write/,
}

async function expectAligned(s: Setup, want: Expected, step: string) {
	const app = asHuman(s)
	const why = (surface: string) => `${step}: ${surface}`

	// 1. The integration list: Integrations page and Keychain page.
	const list = await json<ListRow[]>(
		await app.request(jsonRequest('GET', '/api/integrations', undefined, H(s))),
	)
	const linearRow = list.find((r) => r.id === s.linear.id)
	const stripeRow = list.find((r) => r.id === s.stripeId)
	const grantOf = (row: ListRow) => row.agentGrants.find((g) => g.actorId === s.agent.id)
	expect(linearRow.defaultAgentAccess, why('list default')).toBe(want.linearDefault)
	expect(Boolean(grantOf(linearRow)), why('list linear grant')).toBe(want.linearSource === 'grant')
	expect(Boolean(grantOf(stripeRow)), why('list stripe grant')).toBe(want.stripe === true)
	expect(stripeRow.chatGrants.length, why('list stripe chat grants')).toBe(
		want.stripe === 'chat' ? 1 : 0,
	)

	// 2. The agent's access view: agent page and get_actor.
	const view = await json<AccessView>(
		await app.request(jsonRequest('GET', `/api/actors/${s.agent.id}/access`, undefined, H(s))),
	)
	const vLinear = view.integrations.find((r) => r.integration_id === s.linear.id)
	const vStripe = view.credentials.find((r) => r.integration_id === s.stripeId)
	expect(vLinear.access, why('view linear level')).toBe(want.linear)
	expect(vLinear.source, why('view linear source')).toBe(want.linearSource)
	expect(vLinear.default_access, why('view linear default')).toBe(want.linearDefault)
	expect(vLinear.server_attached, why('view attached')).toBe(want.linear !== 'none')
	// The agent page asks from no chat, so it sees grants only, and says how many chats.
	expect(vStripe.has_access, why('view stripe')).toBe(want.stripe === true)
	expect(vStripe.chat_count, why('view stripe chats')).toBe(want.stripe === 'chat' ? 1 : 0)

	// 3. The session's own credential list (list_keychain_credentials).
	const own = await json(
		await appFor(s.agent.id, 'agent').request(
			jsonRequest('GET', `/api/sessions/${s.chat.id}/keychain-credentials`, undefined, H(s)),
		),
	)
	expect(own.credentials, why('session list')).toEqual([
		{
			name: 'Stripe',
			kind: 'api_key',
			has_access: want.stripe !== false,
			scope: want.stripe === 'chat' ? 'this_chat' : want.stripe ? 'always' : null,
		},
	])

	// 4. What a launched session actually gets.
	const got = await launch(s)
	expect(got.linearAttached, why('launch attaches Linear')).toBe(want.linear !== 'none')
	// A launch outside the chat gets only a grant; one inside it also gets the chat's Allow.
	expect(got.stripeInEnv, why('launch injects Stripe')).toBe(want.stripe === true)
	const inChat = await launch(s, true)
	expect(inChat.stripeInEnv, why('launch in the chat injects Stripe')).toBe(want.stripe !== false)
	expect(got.prompt, why('launch prompt')).toMatch(PROMPT_LABEL[want.linear])
}

describe('Access reads the same on every surface (Integration)', () => {
	it('stays aligned through every way of changing it', async () => {
		const s = await setup()
		const app = asHuman(s)
		const put = (path: string, body: unknown) =>
			app.request(jsonRequest('PUT', `/api/integrations${path}`, body, H(s)))
		const base: Expected = {
			linear: 'read',
			linearSource: 'default',
			linearDefault: 'read',
			stripe: false,
		}

		await expectAligned(s, base, 'initial')

		expect(
			(await put(`/${s.linear.id}/default-access`, { defaultAgentAccess: 'none' })).status,
		).toBe(200)
		await expectAligned(
			s,
			{ ...base, linear: 'none', linearDefault: 'none' },
			'default switched to none',
		)

		expect((await put(`/${s.linear.id}/grants/${s.agent.id}`, { access: 'read' })).status).toBe(200)
		await expectAligned(
			s,
			{ ...base, linear: 'read', linearSource: 'grant', linearDefault: 'none' },
			'a read grant over a none default',
		)

		expect(
			(
				await put(`/${s.linear.id}/grants`, {
					grants: [{ actorId: s.agent.id, access: 'read_write' }],
				})
			).status,
		).toBe(200)
		expect(
			(
				await put(`/${s.stripeId}/grants`, {
					grants: [{ actorId: s.agent.id, access: 'read_write' }],
				})
			).status,
		).toBe(200)
		await expectAligned(
			s,
			{ linear: 'read_write', linearSource: 'grant', linearDefault: 'none', stripe: true },
			'replace-all on both',
		)

		const del = await app.request(
			jsonRequest(
				'DELETE',
				`/api/integrations/${s.stripeId}/grants/${s.agent.id}`,
				undefined,
				H(s),
			),
		)
		expect(del.status).toBe(200)
		await expectAligned(
			s,
			{ linear: 'read_write', linearSource: 'grant', linearDefault: 'none', stripe: false },
			'stripe grant removed',
		)

		// Allow in this chat only: the chat's own surfaces have it, nobody else's do.
		const allowChat = await app.request(
			jsonRequest(
				'POST',
				`/api/integrations/${s.stripeId}/allow-from-chat`,
				{ sessionId: s.chat.id, scope: 'chat' },
				H(s),
			),
		)
		expect(allowChat.status).toBe(200)
		await expectAligned(
			s,
			{ linear: 'read_write', linearSource: 'grant', linearDefault: 'none', stripe: 'chat' },
			'Allow in this chat only',
		)
		// Turning it off for the agent ends the chat's Allow too.
		await app.request(
			jsonRequest(
				'DELETE',
				`/api/integrations/${s.stripeId}/grants/${s.agent.id}`,
				undefined,
				H(s),
			),
		)
		await expectAligned(
			s,
			{ linear: 'read_write', linearSource: 'grant', linearDefault: 'none', stripe: false },
			'removal also ends the chat Allow',
		)

		const allow = await app.request(
			jsonRequest(
				'POST',
				`/api/integrations/${s.stripeId}/allow-from-chat`,
				{ sessionId: s.chat.id },
				H(s),
			),
		)
		expect(allow.status).toBe(200)
		await expectAligned(
			s,
			{ linear: 'read_write', linearSource: 'grant', linearDefault: 'none', stripe: true },
			'Allow on a chat card',
		)

		expect(
			(await put(`/${s.linear.id}/default-access`, { defaultAgentAccess: 'read' })).status,
		).toBe(200)
		const rm = await app.request(
			jsonRequest(
				'DELETE',
				`/api/integrations/${s.linear.id}/grants/${s.agent.id}`,
				undefined,
				H(s),
			),
		)
		expect(rm.status).toBe(200)
		await expectAligned(s, { ...base, stripe: true }, 'back to the default')

		// One agent taken off an integration everyone else can read.
		expect((await put(`/${s.linear.id}/grants/${s.agent.id}`, { access: 'none' })).status).toBe(200)
		await expectAligned(
			s,
			{ ...base, linear: 'none', linearSource: 'grant', stripe: true },
			'an explicit No access over a read default',
		)
	})

	it('drops the server everywhere when the integration is switched off for agent sessions', async () => {
		const s = await setup()
		await db
			.update(integrations)
			.set({ config: { expose_to_agent_sessions: false } })
			.where(eq(integrations.id, s.linear.id))
		const view = await json<AccessView>(
			await asHuman(s).request(
				jsonRequest('GET', `/api/actors/${s.agent.id}/access`, undefined, H(s)),
			),
		)
		const linear = view.integrations.find((r) => r.integration_id === s.linear.id)
		expect(linear.server_attached).toBe(false)
		expect((await launch(s)).linearAttached).toBe(false)
	})
})
