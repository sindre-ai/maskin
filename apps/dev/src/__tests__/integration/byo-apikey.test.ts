import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import { events, credentialAccessLog, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import { createApiError } from '../../lib/errors'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { getCredential } from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const CANARY = `lin_${'CANARY0123'.repeat(5)}`

let dir: string
let kms: LocalFileKmsProvider

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'byo-apikey-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => captureMock.mockClear())

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

function paste(app: ReturnType<typeof appFor>, workspaceId: string, body: unknown) {
	return app.request('/api/integrations/byo-apikey', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

const validBody = (extra: Record<string, unknown> = {}) => ({
	displayName: 'Linear · Sindre AI',
	rawSecret: CANARY,
	...extra,
})

describe('POST /api/integrations/byo-apikey', () => {
	it('vaults the key active with an envelope, a create audit row and no raw value anywhere', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const res = await paste(appFor(human), ws.id, validBody())
		expect(res.status).toBe(201)
		const { integrationId } = (await res.json()) as { integrationId: string }

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({
			status: 'active',
			source: 'admin_ui',
			providerMode: 'byo_apikey',
			displayName: 'Linear · Sindre AI',
			originSessionId: null,
			undoExpiresAt: null,
			createdBy: human,
		})
		expect(row?.credentials).not.toBe(CANARY)
		expect(row?.credentials).not.toContain(CANARY)
		expect(row?.dekCiphertext).toBeTruthy()
		// Default scope: one actor grant for the member who pasted it.
		expect(row?.scopeGrants).toEqual([{ kind: 'actor', actorId: human }])

		const log = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, integrationId))
		expect(log).toHaveLength(1)
		expect(log[0]).toMatchObject({ action: 'create', source: 'admin_ui', actorId: human })
		expect(await verifyCredentialAccessChain(db, ws.id)).toMatchObject({ ok: true })

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, integrationId), eq(events.entityType, 'integration')))
		expect(evs).toHaveLength(1)
		expect(
			JSON.stringify([row, log, evs], (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
		).not.toContain(CANARY)

		expect(captureMock).toHaveBeenCalledWith(
			'keychain_credential_created',
			human,
			expect.objectContaining({ provider_mode: 'byo_apikey', source: 'admin_ui' }),
		)
		expect(JSON.stringify(captureMock.mock.calls)).not.toContain(CANARY)
	})

	it('lets the same member paste several keys under the same provider', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const app = appFor(human)
		const first = await paste(app, ws.id, validBody({ displayName: 'Linear · one' }))
		const second = await paste(app, ws.id, validBody({ displayName: 'Linear · two' }))
		expect(first.status).toBe(201)
		expect(second.status).toBe(201)
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows.map((r) => r.displayName).sort()).toEqual(['Linear · one', 'Linear · two'])
		expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(['custom']))
		const third = await paste(app, ws.id, validBody({ displayName: 'Linear · three' }))
		expect(third.status).toBe(201)
	})

	it('is readable through getCredential by the member it is scoped to, and by nobody else', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const agent = await insertActor(db, { type: 'agent' })
		const session = await insertSession(db, ws.id, agent.id, human, {})
		const { integrationId } = (await (await paste(appFor(human), ws.id, validBody())).json()) as {
			integrationId: string
		}
		const ctx = (actorId: string) => ({
			requestingActorId: actorId,
			sessionId: session.id,
			requestId: 'req-1',
		})
		const cred = await getCredential(db, ws.id, integrationId, ctx(human), { kms })
		expect(cred.value).toBe(CANARY)
		await expect(getCredential(db, ws.id, integrationId, ctx(agent.id), { kms })).rejects.toThrow()
	})

	it('rejects agent callers and writes nothing', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const agent = await insertActor(db, { type: 'agent' })
		const res = await paste(appFor(agent.id, 'agent'), ws.id, validBody())
		expect(res.status).toBe(403)
		expect(await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))).toEqual(
			[],
		)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it.each([
		['a missing display name', { rawSecret: CANARY }],
		['a blank display name', validBody({ displayName: '   ' })],
		['an empty secret', validBody({ rawSecret: '' })],
		['an unknown field', validBody({ providerMode: 'byo_oauth' })],
	])('rejects %s with a 400 that never echoes the secret', async (_label, body) => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const res = await paste(appFor(human), ws.id, body)
		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain(CANARY)
		expect(await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))).toEqual(
			[],
		)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('rejects a body that is not JSON', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human)
		const res = await paste(appFor(human), ws.id, `not json ${CANARY}`)
		expect(res.status).toBe(400)
		expect(await res.text()).not.toContain(CANARY)
	})
})
