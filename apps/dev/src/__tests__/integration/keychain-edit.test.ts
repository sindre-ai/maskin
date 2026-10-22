import { randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import { events, credentialAccessLog, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createApiError } from '../../lib/errors'
import { decodeLogin } from '../../lib/integrations/byo-login'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { getCredential } from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { insertActor, insertAgentGrant, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Editing a saved key or login: rename, replace the secret, or both. Real Postgres, real
 * envelope. The values are obviously fake and built at runtime so no token-shaped literal
 * sits in the repo.
 */
const OLD_KEY = `lin_${'OLDCANARY1'.repeat(5)}`
const NEW_KEY = `lin_${'NEWCANARY2'.repeat(5)}`
const NEW_PASSWORD = 'new-pw"with\\odd\'chars-æøå'

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => setKmsProviderForTests(undefined))

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.onError((_err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/integrations', integrationsKeychainRoutes)
	return app
}

function post(
	app: ReturnType<typeof appFor>,
	path: string,
	workspaceId: string,
	body: Record<string, unknown>,
) {
	return app.request(`/api/integrations/${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
		body: JSON.stringify(body),
	})
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const app = appFor(human)
	const key = (await (
		await post(app, 'byo-apikey', ws.id, { displayName: 'Linear key', rawSecret: OLD_KEY })
	).json()) as { integrationId: string }
	const login = (await (
		await post(app, 'byo-login', ws.id, {
			displayName: 'e-conomic',
			username: 'me@example.test',
			password: 'old-password',
		})
	).json()) as { integrationId: string }
	return { human, ws, agent, app, keyId: key.integrationId, loginId: login.integrationId }
}

async function readAs(
	s: Awaited<ReturnType<typeof setup>>,
	integrationId: string,
	agentId = s.agent.id,
) {
	const session = await insertSession(db, s.ws.id, agentId, s.human, {})
	return getCredential(
		db,
		s.ws.id,
		integrationId,
		{ requestingActorId: agentId, sessionId: session.id, requestId: `edit-test:${Date.now()}` },
		{ kms },
	)
}

describe('POST /api/integrations/:id/update', () => {
	it('renames a key without touching its secret or its grants', async () => {
		const s = await setup()
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: s.keyId,
			actorId: s.agent.id,
		})

		const res = await post(s.app, `${s.keyId}/update`, s.ws.id, {
			displayName: 'Linear production',
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: s.keyId, renamed: true, secretReplaced: false })

		const [row] = await db.select().from(integrations).where(eq(integrations.id, s.keyId))
		expect(row?.displayName).toBe('Linear production')
		expect((await readAs(s, s.keyId)).value).toBe(OLD_KEY)
	})

	it('replaces an API key, audits it as rotated, and keeps the value out of every row', async () => {
		const s = await setup()
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: s.keyId,
			actorId: s.agent.id,
		})

		const res = await post(s.app, `${s.keyId}/update`, s.ws.id, { rawSecret: NEW_KEY })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: s.keyId, renamed: false, secretReplaced: true })

		expect((await readAs(s, s.keyId)).value).toBe(NEW_KEY)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, s.keyId))
		expect(row?.displayName).toBe('Linear key')

		const log = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, s.keyId))
		expect(log.map((l) => l.action)).toContain('rotated')
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true })

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.keyId), eq(events.entityType, 'integration')))
		const dump = JSON.stringify([row, log, evs], (_k, v) =>
			typeof v === 'bigint' ? v.toString() : v,
		)
		expect(dump).not.toContain(NEW_KEY)
		expect(dump).not.toContain(OLD_KEY)
	})

	it('replaces a login as a whole and decrypts to exactly what was typed', async () => {
		const s = await setup()
		await insertAgentGrant(db, {
			workspaceId: s.ws.id,
			integrationId: s.loginId,
			actorId: s.agent.id,
		})

		const res = await post(s.app, `${s.loginId}/update`, s.ws.id, {
			displayName: 'e-conomic prod',
			username: 'you@example.test',
			password: NEW_PASSWORD,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: s.loginId, renamed: true, secretReplaced: true })
		expect(decodeLogin((await readAs(s, s.loginId)).value)).toEqual({
			username: 'you@example.test',
			password: NEW_PASSWORD,
		})
	})

	it('refuses a name another credential holds, but lets a credential keep its own name in another case', async () => {
		const s = await setup()
		const taken = await post(s.app, `${s.keyId}/update`, s.ws.id, { displayName: 'E-Conomic' })
		expect(taken.status).toBe(409)
		expect(((await taken.json()) as { error: { code: string } }).error.code).toBe('NAME_TAKEN')

		const own = await post(s.app, `${s.keyId}/update`, s.ws.id, { displayName: 'LINEAR KEY' })
		expect(own.status).toBe(200)
	})

	it('refuses a bad name, a bad value, a half login, an empty edit and the wrong shape', async () => {
		const s = await setup()
		const bad = (id: string, body: Record<string, unknown>) =>
			post(s.app, `${id}/update`, s.ws.id, body).then((r) => r.status)
		expect(await bad(s.keyId, { displayName: 'has [brackets]' })).toBe(400)
		expect(await bad(s.keyId, { rawSecret: 'two\nlines' })).toBe(400)
		expect(await bad(s.loginId, { username: 'only-a-username' })).toBe(400)
		expect(await bad(s.keyId, {})).toBe(400)
		// A login takes a username and password, a key takes a key.
		expect(await bad(s.keyId, { username: 'a', password: 'b' })).toBe(400)
		expect(await bad(s.loginId, { rawSecret: NEW_KEY })).toBe(400)
	})

	it('is for the person who saved it or a workspace admin, never an agent or a plain member', async () => {
		const s = await setup()
		const member = await insertActor(db, { type: 'human' })
		const admin = await insertActor(db, { type: 'human' })
		await db.insert(workspaceMembers).values([
			{ workspaceId: s.ws.id, actorId: member.id, role: 'member' },
			{ workspaceId: s.ws.id, actorId: admin.id, role: 'admin' },
		])
		const edit = (app: ReturnType<typeof appFor>) =>
			post(app, `${s.keyId}/update`, s.ws.id, { displayName: 'Renamed' }).then((r) => r.status)

		expect(await edit(appFor(s.agent.id, 'agent'))).toBe(403)
		expect(await edit(appFor(member.id))).toBe(403)
		expect(await edit(appFor(admin.id))).toBe(200)
	})

	it('404s an unknown id and 409s a removed credential', async () => {
		const s = await setup()
		expect(
			(await post(s.app, `${crypto.randomUUID()}/update`, s.ws.id, { displayName: 'X' })).status,
		).toBe(404)

		expect((await post(s.app, `${s.keyId}/remove`, s.ws.id, {})).status).toBe(200)
		expect((await post(s.app, `${s.keyId}/update`, s.ws.id, { displayName: 'Back' })).status).toBe(
			409,
		)
	})
})
