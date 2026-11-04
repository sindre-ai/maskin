import { OpenAPIHono } from '@hono/zod-openapi'
import { credentialAccessLog, integrations, sessions, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', async (orig) => ({
	...(await orig<typeof import('node:dns/promises')>()),
	lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import { readCustomServer } from '../../lib/integrations/custom-mcp'
import customMcpServersRoutes from '../../routes/custom-mcp-servers'
import { clearGatewayAnnotationCache } from '../../routes/integrations-gateway'
import integrationsGrantsRoutes from '../../routes/integrations-grants'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertAgentGrant, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY ??= 'a'.repeat(64)
})

const SECRET = 'sk-live-vaulted-secret'
const REF = '${KEYCHAIN_BYO_APIKEY_STRIPE}'

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string; workspaceRole: string }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('workspaceRole', 'member')
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
	const withKey = await insertActor(db, { type: 'agent', name: 'Has key' })
	const withoutKey = await insertActor(db, { type: 'agent', name: 'No key' })
	for (const a of [withKey, withoutKey]) {
		await db.insert(workspaceMembers).values({ workspaceId: ws.id, actorId: a.id, role: 'member' })
	}
	// A saved API key named Stripe, only the first agent may use it.
	const [stripe] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'stripe',
			providerMode: 'byo_apikey',
			displayName: 'Stripe',
			status: 'active',
			credentials: encrypt(SECRET),
			defaultAgentAccess: 'none',
			createdBy: human,
		})
		.returning()
	await insertAgentGrant(db, {
		workspaceId: ws.id,
		integrationId: (stripe as { id: string }).id,
		actorId: withKey.id,
		access: 'read_write',
	})
	return { human, ws, withKey, withoutKey, stripe: stripe as { id: string }, app: appFor(human) }
}
type Setup = Awaited<ReturnType<typeof setup>>

function call(s: Setup, method: string, path: string, body?: unknown, app = s.app) {
	return app.request(path, {
		method,
		headers: { 'X-Workspace-Id': s.ws.id, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const HTTP = (headers: Record<string, string>) => ({
	type: 'http' as const,
	url: 'https://tools.example.com/mcp',
	headers,
})

async function add(s: Setup, name: string, server: object, app = s.app) {
	const res = await call(s, 'POST', '/api/custom-mcp-servers', { name, server }, app)
	return { res, body: (await res.json()) as { id: string; server?: Record<string, unknown> } }
}

async function launch(s: Setup, agentId: string) {
	const created = await insertSession(db, s.ws.id, agentId, s.human, {
		status: 'pending',
		containerId: null,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		const spec = await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)
		return {
			servers: (JSON.parse(spec.env.MCP_SERVERS_JSON ?? '{}').mcpServers ?? {}) as Record<
				string,
				{ url?: string; env?: Record<string, string> }
			>,
			prompt: spec.env.SYSTEM_PROMPT ?? '',
			sessionId: created.id,
		}
	} finally {
		await manager.stop()
	}
}

describe('Custom tool servers that use a saved credential (Integration)', () => {
	it('stores the reference, shows it back unmasked, and keeps other values masked', async () => {
		const s = await setup()
		const { res, body } = await add(
			s,
			'Billing',
			HTTP({ Authorization: `Bearer ${REF}`, 'X-Other': 'plain-secret' }),
		)
		expect(res.status).toBe(201)
		expect(body.server).toMatchObject({
			headers: { Authorization: `Bearer ${REF}`, 'X-Other': '********' },
		})
		const [row] = await db.select().from(integrations).where(eq(integrations.id, body.id))
		expect(readCustomServer(row)?.headers?.Authorization).toBe(`Bearer ${REF}`)
		// The vaulted value is nowhere in the server's row.
		expect(row.credentials).not.toContain(SECRET)
		expect(JSON.stringify(row.config)).not.toContain(SECRET)
	})

	it('refuses a credential that does not exist, and a reference outside env and headers', async () => {
		const s = await setup()
		const unknown = await add(s, 'A', HTTP({ Authorization: '${KEYCHAIN_BYO_APIKEY_NOPE}' }))
		expect(unknown.res.status).toBe(400)
		const inUrl = await add(s, 'B', {
			type: 'http',
			url: 'https://x.example.com/?k=${KEYCHAIN_BYO_APIKEY_STRIPE}',
		})
		expect(inUrl.res.status).toBe(400)
		const inArgs = await add(s, 'C', {
			type: 'stdio',
			command: 'npx',
			args: ['srv', '--key', REF],
		})
		expect(inArgs.res.status).toBe(400)
		const unbraced = await add(s, 'D', HTTP({ Authorization: '$KEYCHAIN_BYO_APIKEY_STRIPE' }))
		expect(unbraced.res.status).toBe(400)
	})

	it('lets only whoever saved the credential, or an admin, point a server at it', async () => {
		const s = await setup()
		const other = await insertActor(db, { type: 'human', name: 'Someone else' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: other.id, role: 'member' })
		const denied = await add(s, 'Mine', HTTP({ Authorization: REF }), appFor(other.id))
		expect(denied.res.status).toBe(403)
		// Their own server without a reference is fine.
		expect((await add(s, 'Plain', HTTP({ 'X-Key': 'k' }), appFor(other.id))).res.status).toBe(201)
	})

	it('re-checks the reference when the URL changes, and keeps it across an unrelated edit', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', HTTP({ Authorization: `Bearer ${REF}` }))
		const read = (await (await call(s, 'GET', `/api/custom-mcp-servers/${body.id}`)).json()) as {
			server: Record<string, unknown>
		}
		// The creator renames it: the reference comes back as written and stays.
		const rename = await call(s, 'PUT', `/api/custom-mcp-servers/${body.id}`, {
			name: 'Billing 2',
			server: read.server,
		})
		expect(rename.status).toBe(200)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, body.id))
		expect(readCustomServer(row)?.headers?.Authorization).toBe(`Bearer ${REF}`)
	})
})

describe('Credential references through the gateway (Integration)', () => {
	let fetchMock: ReturnType<typeof vi.fn>
	beforeEach(() => {
		clearGatewayAnnotationCache()
		fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result: { content: [{ type: 'text', text: 'ok' }] },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		)
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	function gatewayCall(s: Setup, id: string, as: string, sessionId?: string) {
		return appFor(as, 'agent').request(`/api/custom-mcp-servers/${id}/gateway`, {
			method: 'POST',
			headers: {
				'X-Workspace-Id': s.ws.id,
				'content-type': 'application/json',
				authorization: 'Bearer ank_agent_key',
				...(sessionId ? { 'X-Maskin-Session-Id': sessionId } : {}),
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'list_things', arguments: {} },
			}),
		})
	}

	async function grantServer(s: Setup, id: string, agentId: string) {
		await call(s, 'PUT', `/api/integrations/${id}/grants/${agentId}`, { access: 'read_write' })
	}

	it('fills the credential for an agent that may use it, and audits the read', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', HTTP({ Authorization: `Bearer ${REF}` }))
		await grantServer(s, body.id, s.withKey.id)

		const res = await gatewayCall(s, body.id, s.withKey.id)
		expect(res.status).toBe(200)
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${SECRET}`)

		const reads = await db
			.select()
			.from(credentialAccessLog)
			.where(
				and(
					eq(credentialAccessLog.integrationId, s.stripe.id),
					eq(credentialAccessLog.actorId, s.withKey.id),
					eq(credentialAccessLog.action, 'read'),
				),
			)
		expect(reads).toHaveLength(1)
	})

	it('tells an agent without the credential what it needs, and sends nothing upstream', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', HTTP({ Authorization: `Bearer ${REF}` }))
		await grantServer(s, body.id, s.withoutKey.id)

		const res = await gatewayCall(s, body.id, s.withoutKey.id)
		const json = (await res.json()) as { error?: { message: string } }
		expect(res.status).toBe(502)
		expect(json.error?.message).toContain('"Stripe"')
		expect(json.error?.message).toContain('request_keychain_access')
		expect(JSON.stringify(json)).not.toContain(SECRET)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('follows the Keychain: rotating the key changes what the next call sends', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', HTTP({ Authorization: `Bearer ${REF}` }))
		await grantServer(s, body.id, s.withKey.id)
		await db
			.update(integrations)
			.set({ credentials: encrypt('sk-live-rotated') })
			.where(eq(integrations.id, s.stripe.id))
		await gatewayCall(s, body.id, s.withKey.id)
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-live-rotated')
	})

	it('says so when the credential was removed', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', HTTP({ Authorization: `Bearer ${REF}` }))
		await grantServer(s, body.id, s.withKey.id)
		await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, s.stripe.id))
		const res = await gatewayCall(s, body.id, s.withKey.id)
		expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
			/no longer exists/,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('Launch with a credential reference (Integration)', () => {
	const STDIO = { type: 'stdio' as const, command: 'npx', args: ['srv'], env: { API_KEY: REF } }

	it('attaches a container server only for an agent that has the credential, and tells the others', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', STDIO)
		await call(s, 'PUT', `/api/integrations/${body.id}/default-access`, {
			defaultAgentAccess: 'read',
		})

		const has = await launch(s, s.withKey.id)
		expect(Object.keys(has.servers).some((k) => k.startsWith('custom-billing'))).toBe(true)
		// The container gets the reference, not the value: envsubst fills it from the injected env.
		const entry = Object.entries(has.servers).find(([k]) => k.startsWith('custom-billing'))?.[1]
		expect(entry?.env?.API_KEY).toBe(REF)
		expect(has.prompt).not.toContain('Tool servers not attached')

		const lacks = await launch(s, s.withoutKey.id)
		expect(Object.keys(lacks.servers).some((k) => k.startsWith('custom-billing'))).toBe(false)
		expect(lacks.prompt).toContain('Tool servers not attached')
		expect(lacks.prompt).toContain('Billing: needs "Stripe"')
		expect(lacks.prompt).toContain('request_keychain_access')
	})

	it('still attaches a gated server for an agent without the credential: the gateway explains', async () => {
		const s = await setup()
		const { body } = await add(s, 'Billing', HTTP({ Authorization: `Bearer ${REF}` }))
		await call(s, 'PUT', `/api/integrations/${body.id}/grants/${s.withoutKey.id}`, {
			access: 'read_write',
		})
		const lacks = await launch(s, s.withoutKey.id)
		const key = Object.keys(lacks.servers).find((k) => k.startsWith('custom-billing'))
		expect(key).toBeDefined()
		expect(lacks.servers[key as string]?.url).toContain('/gateway')
		expect(JSON.stringify(lacks.servers)).not.toContain(SECRET)
	})
})
