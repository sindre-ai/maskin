import { randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import {
	events,
	conversationParticipants,
	credentialAccessLog,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createApiError } from '../../lib/errors'
import { decodeLogin } from '../../lib/integrations/byo-login'
import { getCredential } from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { SessionManager } from '../../services/session-manager'
import {
	grantedActorIds,
	insertActor,
	insertAgentGrant,
	insertConversation,
	insertSession,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'
import { fakeSessionControl } from './session-control-fake'

/**
 * Keychain logins (provider_mode 'byo_login'): a username and password held as one
 * envelope-encrypted credential, from the Keychain form and from the chat card, and
 * injected into a granted session as two env vars.
 *
 * Against real Postgres because what is under test is database behaviour: the
 * partial unique index migration 0093 widened, the slug uniqueness across both modes,
 * and the audit and event rows that must never hold the value.
 */

// Obviously fake, built at runtime. The password has the characters an API key may not
// (a quote, a backslash, a non-ASCII letter), which a real password routinely does.
const USERNAME = `bookkeeper-${'canary'.repeat(2)}@example.test`
const PASSWORD = `pw"with\\odd'chars-æøå-${'CANARY0123'.repeat(2)}`

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => setKmsProviderForTests(undefined))

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string; sessionManager: SessionManager }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', fakeSessionControl() as unknown as SessionManager)
		await next()
	})
	app.onError((_err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/integrations', integrationsKeychainRoutes)
	return app
}

function post(app: ReturnType<typeof appFor>, path: string, workspaceId: string, body: unknown) {
	return app.request(`/api/integrations/${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify(body),
	})
}

const loginBody = (extra: Record<string, unknown> = {}) => ({
	displayName: 'e-conomic',
	username: USERNAME,
	password: PASSWORD,
	...extra,
})

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

async function launchEnv(session: typeof sessions.$inferSelect) {
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(session)).env
	} finally {
		await manager.stop()
	}
}

async function setupWithAgent() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agent = await insertActor(db, { type: 'agent', systemPrompt: 'Agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const conversation = await insertConversation(db, ws.id, human)
	await db
		.insert(conversationParticipants)
		.values({ conversationId: conversation.id, actorId: human })
	const session = await insertSession(db, ws.id, agent.id, human, {
		status: 'pending',
		containerId: null,
		conversationId: conversation.id,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
	return { human, ws, agent, conversation, session: row as typeof sessions.$inferSelect }
}

describe('POST /api/integrations/byo-login', () => {
	it('vaults the login active as one envelope and decrypts back to exactly what was typed', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const res = await post(appFor(human), 'byo-login', ws.id, loginBody())
		expect(res.status).toBe(201)
		const { integrationId } = (await res.json()) as { integrationId: string }

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({
			status: 'active',
			providerMode: 'byo_login',
			provider: 'login',
			displayName: 'e-conomic',
			source: 'admin_ui',
		})
		// No agent holds it until a person grants one.
		expect(await grantedActorIds(db, integrationId)).toEqual([])
		expect(row?.dekCiphertext).toBeTruthy()

		const agent = await insertActor(db, { type: 'agent' })
		await insertAgentGrant(db, { workspaceId: ws.id, integrationId, actorId: agent.id })
		const credential = await getCredential(db, ws.id, integrationId, {
			requestingActorId: agent.id,
			requestId: 'test:byo-login-roundtrip',
		})
		expect(decodeLogin(credential.value)).toEqual({ username: USERNAME, password: PASSWORD })
	})

	it('puts neither the username nor the password in any row it writes', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const res = await post(appFor(human), 'byo-login', ws.id, loginBody())
		const { integrationId } = (await res.json()) as { integrationId: string }

		// Audit rows carry bigint ids, which JSON cannot serialise on its own.
		const stored = JSON.stringify(
			[
				await db.select().from(integrations).where(eq(integrations.id, integrationId)),
				await db
					.select()
					.from(credentialAccessLog)
					.where(eq(credentialAccessLog.workspaceId, ws.id)),
				await db.select().from(events).where(eq(events.workspaceId, ws.id)),
			],
			(_key, value) => (typeof value === 'bigint' ? value.toString() : value),
		)
		expect(stored).not.toContain(USERNAME)
		expect(stored).not.toContain('CANARY0123')
		expect(stored).not.toContain('canary')
	})

	it('lets one workspace hold several logins (the index migration 0093 widened)', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const app = appFor(human)

		const first = await post(app, 'byo-login', ws.id, loginBody({ displayName: 'e-conomic' }))
		const second = await post(app, 'byo-login', ws.id, loginBody({ displayName: 'Dinero' }))

		expect(first.status).toBe(201)
		expect(second.status).toBe(201)
	})

	it('refuses a name another key or login already holds, whichever kind it was', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const app = appFor(human)
		const key = await post(app, 'byo-apikey', ws.id, {
			displayName: 'e-conomic',
			rawSecret: `key_${'CANARY0123'.repeat(3)}`,
		})
		expect(key.status).toBe(201)

		// Same slug (E_CONOMIC), different spelling.
		const login = await post(app, 'byo-login', ws.id, loginBody({ displayName: 'E conomic' }))

		expect(login.status).toBe(409)
		expect(((await login.json()) as { error: { code: string } }).error.code).toBe('NAME_TAKEN')
	})

	it.each([
		['an empty password', { password: '' }],
		['a password with a line break', { password: 'abc\ndef' }],
		['a username with surrounding whitespace', { username: ' someone ' }],
		['a missing username', { username: undefined }],
	])('refuses %s with a 400 that never repeats the value', async (_label, override) => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)

		const res = await post(appFor(human), 'byo-login', ws.id, loginBody(override))

		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).not.toContain(PASSWORD)
	})

	it('refuses an agent: an agent that held a password has already seen it', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const agent = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

		const res = await post(appFor(agent.id, 'agent'), 'byo-login', ws.id, loginBody())

		expect(res.status).toBe(403)
	})
})

describe('POST /api/integrations/chat-capture — login from a card', () => {
	it('vaults a login active at once, with no undo window, shared with exactly the agents ticked', async () => {
		const s = await setupWithAgent()
		const other = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: other.id, role: 'member' })

		const res = await post(appFor(s.human), 'chat-capture', s.ws.id, {
			sessionId: s.session.id,
			providerMode: 'byo_login',
			displayName: 'e-conomic',
			username: USERNAME,
			password: PASSWORD,
			agentIds: [s.agent.id],
			fromCard: true,
		})
		expect(res.status).toBe(201)
		const out = (await res.json()) as {
			integrationId: string
			undoExpiresAt: string | null
			undoUrl: string | null
		}
		const { integrationId } = out
		// A card has no Undo button, so nothing to undo and no window to wait out.
		expect(out.undoExpiresAt).toBeNull()
		expect(out.undoUrl).toBeNull()

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.undoExpiresAt).toBeNull()
		expect(row).toMatchObject({
			status: 'active',
			providerMode: 'byo_login',
			provider: 'login',
			source: 'chat_capture',
			originSessionId: s.session.id,
		})
		expect(await grantedActorIds(db, integrationId)).toEqual([s.agent.id])

		// The agent the person ticked can read it; the agent they did not, cannot.
		const mine = await getCredential(db, s.ws.id, integrationId, {
			requestingActorId: s.agent.id,
			requestId: 'test:granted',
		})
		expect(decodeLogin(mine.value)?.username).toBe(USERNAME)
		await expect(
			getCredential(db, s.ws.id, integrationId, {
				requestingActorId: other.id,
				requestId: 'test:ungranted',
			}),
		).rejects.toThrow()
	})

	it('keeps the undo window for a login that did not come from a card', async () => {
		const s = await setupWithAgent()

		const res = await post(appFor(s.human), 'chat-capture', s.ws.id, {
			sessionId: s.session.id,
			providerMode: 'byo_login',
			displayName: 'e-conomic',
			username: USERNAME,
			password: PASSWORD,
		})

		expect(res.status).toBe(201)
		const out = (await res.json()) as { integrationId: string; undoExpiresAt: string | null }
		expect(out.undoExpiresAt).not.toBeNull()
		const [row] = await db.select().from(integrations).where(eq(integrations.id, out.integrationId))
		expect(row?.status).toBe('pending_undo')
	})

	it('still takes an API key typed into a card, the same way', async () => {
		const s = await setupWithAgent()

		const res = await post(appFor(s.human), 'chat-capture', s.ws.id, {
			sessionId: s.session.id,
			providerMode: 'byo_apikey',
			detectedProvider: 'manual',
			displayName: 'Stripe',
			rawSecret: `key_${'CANARY0123'.repeat(3)}`,
			agentIds: [s.agent.id],
			fromCard: true,
		})

		expect(res.status).toBe(201)
	})

	it('refuses a body that mixes the two shapes', async () => {
		const s = await setupWithAgent()

		const res = await post(appFor(s.human), 'chat-capture', s.ws.id, {
			sessionId: s.session.id,
			providerMode: 'byo_login',
			displayName: 'e-conomic',
			username: USERNAME,
			password: PASSWORD,
			rawSecret: 'also-a-key',
		})

		expect(res.status).toBe(400)
	})
})

describe('SessionManager.buildLaunchSpec — login env injection', () => {
	async function vaultLogin(s: Awaited<ReturnType<typeof setupWithAgent>>, name: string) {
		const res = await post(appFor(s.human), 'chat-capture', s.ws.id, {
			sessionId: s.session.id,
			providerMode: 'byo_login',
			displayName: name,
			username: USERNAME,
			password: PASSWORD,
			agentIds: [s.agent.id],
		})
		expect(res.status).toBe(201)
		return ((await res.json()) as { integrationId: string }).integrationId
	}

	it('gives a granted agent KEYCHAIN_BYO_LOGIN_<SLUG>_USERNAME and _PASSWORD, exactly as typed', async () => {
		const s = await setupWithAgent()
		await vaultLogin(s, 'e-conomic')

		const env = await launchEnv(s.session)

		expect(env.KEYCHAIN_BYO_LOGIN_E_CONOMIC_USERNAME).toBe(USERNAME)
		expect(env.KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD).toBe(PASSWORD)
	})

	it('gives an agent that was not ticked nothing', async () => {
		const s = await setupWithAgent()
		await vaultLogin(s, 'e-conomic')
		const other = await insertActor(db, { type: 'agent', systemPrompt: 'Other' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: other.id, role: 'member' })
		const otherSession = await insertSession(db, s.ws.id, other.id, s.human, {
			status: 'pending',
			containerId: null,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, otherSession.id))

		const env = await launchEnv(row as typeof sessions.$inferSelect)

		expect(Object.keys(env).filter((k) => k.startsWith('KEYCHAIN_BYO_LOGIN_'))).toEqual([])
	})

	it('injects nothing once the login has been undone', async () => {
		const s = await setupWithAgent()
		const id = await vaultLogin(s, 'e-conomic')
		await db
			.update(integrations)
			.set({ status: 'undone', credentials: null, dekCiphertext: null })
			.where(eq(integrations.id, id))

		const env = await launchEnv(s.session)

		expect(env.KEYCHAIN_BYO_LOGIN_E_CONOMIC_USERNAME).toBeUndefined()
		expect(env.KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD).toBeUndefined()
	})

	it('injects a key and a login side by side', async () => {
		const s = await setupWithAgent()
		await vaultLogin(s, 'e-conomic')
		const keyRes = await post(appFor(s.human), 'chat-capture', s.ws.id, {
			sessionId: s.session.id,
			providerMode: 'byo_apikey',
			detectedProvider: 'manual',
			displayName: 'Stripe',
			rawSecret: `key_${'CANARY0123'.repeat(3)}`,
			agentIds: [s.agent.id],
		})
		expect(keyRes.status).toBe(201)

		const env = await launchEnv(s.session)

		expect(env.KEYCHAIN_BYO_APIKEY_STRIPE).toBe(`key_${'CANARY0123'.repeat(3)}`)
		expect(env.KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD).toBe(PASSWORD)
	})
})
