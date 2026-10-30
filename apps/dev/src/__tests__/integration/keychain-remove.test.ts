import { randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import {
	events,
	credentialAccessLog,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createApiError } from '../../lib/errors'
import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { createByoLogin } from '../../lib/integrations/byo-login'
import { CredentialUndoneError } from '../../lib/integrations/errors'
import { getCredential } from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsGrantsRoutes from '../../routes/integrations-grants'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { SessionManager } from '../../services/session-manager'
import {
	buildIntegration,
	grantedActorIds,
	insertActor,
	insertAgentGrant,
	insertSession,
	insertWorkspace,
} from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'
import { fakeSessionControl } from './session-control-fake'

/**
 * POST /api/integrations/:id/remove — a person removes a saved key or login at any
 * time. The secret is destroyed (not hidden), the row stays for the audit chain, and
 * nothing is injected from it again.
 *
 * Against real Postgres because what is under test is database state: the secret and
 * its wrapped key are zeroed, the audit and event rows are written, and the credential
 * stops reaching new sessions.
 */

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const KEY = `key_${'CANARY0123'.repeat(3)}`
const PASSWORD = `pw"odd\\chars-${'CANARY0123'.repeat(2)}`

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
	app.route('/api/integrations', integrationsGrantsRoutes)
	return app
}

function remove(app: ReturnType<typeof appFor>, workspaceId: string, integrationId: string) {
	return app.request(`/api/integrations/${integrationId}/remove`, {
		method: 'POST',
		headers: { 'x-workspace-id': workspaceId },
	})
}

function putGrants(
	app: ReturnType<typeof appFor>,
	workspaceId: string,
	integrationId: string,
	actorIds: string[],
) {
	return app.request(`/api/integrations/${integrationId}/grants`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify({
			grants: actorIds.map((actorId) => ({ actorId, access: 'read_write' })),
		}),
	})
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
	const agent = await insertActor(db, { type: 'agent', systemPrompt: 'Agent' })
	// A plain member who did not save it, and an admin who did not save it either.
	const member = await insertActor(db, { type: 'human' })
	const admin = await insertActor(db, { type: 'human' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: agent.id, role: 'member' },
		{ workspaceId: ws.id, actorId: member.id, role: 'member' },
		{ workspaceId: ws.id, actorId: admin.id, role: 'admin' },
	])
	const key = await createByoApiKey(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'Coolify',
		rawSecret: KEY,
	})
	await insertAgentGrant(db, {
		workspaceId: ws.id,
		integrationId: key.integrationId,
		actorId: agent.id,
	})
	const login = await createByoLogin(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'e-conomic',
		username: 'me@example.test',
		password: PASSWORD,
	})
	await insertAgentGrant(db, {
		workspaceId: ws.id,
		integrationId: login.integrationId,
		actorId: agent.id,
	})
	return { human, ws, agent, member, admin, keyId: key.integrationId, loginId: login.integrationId }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function rowOf(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return row
}

async function launchEnv(s: Setup) {
	const session = await insertSession(db, s.ws.id, s.agent.id, s.human, {
		status: 'pending',
		containerId: null,
	})
	const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
	} finally {
		await manager.stop()
	}
}

describe('POST /api/integrations/:id/remove (Integration)', () => {
	it('destroys an API key: secret and wrapped key gone, row kept, unreadable from then on', async () => {
		const s = await setup()

		const res = await remove(appFor(s.human), s.ws.id, s.keyId)

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ id: s.keyId, status: 'undone', sessionEnded: true })
		const row = await rowOf(s.keyId)
		expect(row).toMatchObject({ status: 'undone', credentials: null, dekCiphertext: null })
		await expect(
			getCredential(db, s.ws.id, s.keyId, { requestingActorId: s.agent.id, requestId: 'test' }),
		).rejects.toBeInstanceOf(CredentialUndoneError)
	})

	it('destroys a login the same way', async () => {
		const s = await setup()

		const res = await remove(appFor(s.human), s.ws.id, s.loginId)

		expect(res.status).toBe(200)
		expect(await rowOf(s.loginId)).toMatchObject({
			status: 'undone',
			credentials: null,
			dekCiphertext: null,
		})
	})

	it('writes one audit row and one event, and neither holds the secret', async () => {
		const s = await setup()

		await remove(appFor(s.human), s.ws.id, s.loginId)

		const audit = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, s.loginId))
		const removal = audit.filter((r) => r.action === 'undone')
		expect(removal).toHaveLength(1)
		expect(removal[0]?.requestId).toBe(`remove:${s.loginId}`)
		expect(removal[0]?.actorId).toBe(s.human)
		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, s.ws.id), eq(events.entityId, s.loginId)))
		expect(evs.some((e) => (e.data as { reason?: string } | null)?.reason === 'removed')).toBe(true)
		const stored = JSON.stringify([audit, evs], (_k, v) =>
			typeof v === 'bigint' ? v.toString() : v,
		)
		expect(stored).not.toContain('CANARY0123')
		expect(stored).not.toContain('me@example.test')
	})

	it('stops injecting it into new sessions, and a login beside it never was', async () => {
		const s = await setup()
		const before = await launchEnv(s)
		expect(before.KEYCHAIN_BYO_APIKEY_COOLIFY).toBe(KEY)
		expect(before.KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD).toBeUndefined()

		await remove(appFor(s.human), s.ws.id, s.keyId)

		const after = await launchEnv(s)
		expect(after.KEYCHAIN_BYO_APIKEY_COOLIFY).toBeUndefined()
		expect(after.KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD).toBeUndefined()
	})

	it('gives the name back, so the same name can be saved again', async () => {
		const s = await setup()
		await remove(appFor(s.human), s.ws.id, s.keyId)

		await expect(
			createByoApiKey(db, kms, {
				workspaceId: s.ws.id,
				actorId: s.human,
				displayName: 'Coolify',
				rawSecret: KEY,
			}),
		).resolves.toBeTruthy()
	})

	it('removes a credential still inside its undo window too', async () => {
		const s = await setup()
		await db
			.update(integrations)
			.set({ status: 'pending_undo', undoExpiresAt: new Date(Date.now() + 60_000) })
			.where(eq(integrations.id, s.keyId))

		const res = await remove(appFor(s.human), s.ws.id, s.keyId)

		expect(res.status).toBe(200)
		expect((await rowOf(s.keyId))?.status).toBe('undone')
	})

	it('lets a workspace admin remove one they did not save', async () => {
		const s = await setup()

		const res = await remove(appFor(s.admin.id), s.ws.id, s.keyId)

		expect(res.status).toBe(200)
	})

	it('refuses a plain member who did not save it, and leaves the secret intact', async () => {
		const s = await setup()

		const res = await remove(appFor(s.member.id), s.ws.id, s.keyId)

		expect(res.status).toBe(403)
		expect((await rowOf(s.keyId))?.credentials).not.toBeNull()
	})

	it('refuses an agent: only a person decides what the vault holds', async () => {
		const s = await setup()

		const res = await remove(appFor(s.agent.id, 'agent'), s.ws.id, s.keyId)

		expect(res.status).toBe(403)
		expect((await rowOf(s.keyId))?.credentials).not.toBeNull()
	})

	it('answers 409 the second time, and for a connection that is not a saved key or login', async () => {
		const s = await setup()
		const app = appFor(s.human)
		expect((await remove(app, s.ws.id, s.keyId)).status).toBe(200)
		expect((await remove(app, s.ws.id, s.keyId)).status).toBe(409)

		const [oauth] = await db
			.insert(integrations)
			.values(buildIntegration({ workspaceId: s.ws.id, provider: 'linear', createdBy: s.human }))
			.returning()
		expect((await remove(app, s.ws.id, (oauth as { id: string }).id)).status).toBe(409)
		expect((await rowOf((oauth as { id: string }).id))?.status).not.toBe('undone')
	})

	it('answers 404 for an unknown id and for another workspace’s credential', async () => {
		const s = await setup()
		const other = await insertWorkspace(db, s.human)

		expect(
			(await remove(appFor(s.human), s.ws.id, '99999999-9999-4999-8999-999999999999')).status,
		).toBe(404)
		expect((await remove(appFor(s.human), other.id, s.keyId)).status).toBe(404)
		expect((await rowOf(s.keyId))?.credentials).not.toBeNull()
	})
})

describe('PUT /api/integrations/:id/grants for a login (Integration)', () => {
	it('lets the person change which agents can use a login, as for an API key', async () => {
		const s = await setup()
		const other = await insertActor(db, { type: 'agent', systemPrompt: 'Other' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: other.id, role: 'member' })

		const res = await putGrants(appFor(s.human), s.ws.id, s.loginId, [other.id])

		expect(res.status).toBe(200)
		expect(await grantedActorIds(db, s.loginId)).toEqual([other.id])
	})
})

describe('DELETE /api/integrations/:id on a Keychain credential (Integration)', () => {
	it('refuses with 409 and leaves the secret in place, for a key and a login', async () => {
		const s = await setup()
		const { default: integrationsRoutes } = await import('../../routes/integrations')
		const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })

		for (const id of [s.keyId, s.loginId]) {
			const res = await app.request(`/api/integrations/${id}`, {
				method: 'DELETE',
				headers: { 'x-workspace-id': s.ws.id },
			})
			expect(res.status).toBe(409)
			const row = await rowOf(id)
			expect(row?.status).toBe('active')
			expect(row?.credentials).not.toBeNull()
		}
	})
})
