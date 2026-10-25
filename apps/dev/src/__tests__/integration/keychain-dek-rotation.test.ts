import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type KmsProvider, MasterKeyProvider } from '@maskin/auth/kms'
import { credentialAccessLog, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { RotateDeksJob } from '../../jobs/rotate-deks'
import { decryptStoredCredential, encrypt, encryptEnvelope } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import {
	insertCredentialAccessLog,
	verifyCredentialAccessChain,
} from '../../lib/integrations/credential-audit'
import { rotateIntegrationDek } from '../../lib/integrations/rotate-dek'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

let dir: string
let kms: MasterKeyProvider
let hooked: KmsProvider
let beforeEncrypt: (() => Promise<void>) | undefined

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'dek-rotation-kek-'))
	kms = new MasterKeyProvider(randomBytes(32))
	// Lets a test run a concurrent write in the middle of a rotation.
	hooked = {
		async encrypt(workspaceId, plaintext) {
			await beforeEncrypt?.()
			return kms.encrypt(workspaceId, plaintext)
		},
		decrypt: (workspaceId, ciphertext) => kms.decrypt(workspaceId, ciphertext),
	}
	setKmsProviderForTests(hooked)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})
async function envelopeRow(workspaceId: string, provider: string, plaintext: string) {
	const env = await encryptEnvelope(kms, workspaceId, plaintext)
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status: 'active',
			credentials: env.credentials,
			dekCiphertext: env.dekCiphertext,
			createdBy: getTestActorId(),
		})
		.returning()
	if (!row) throw new Error('insert returned no row')
	return row
}

async function reload(id: string) {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	if (!row) throw new Error('row vanished')
	return row
}

async function plaintextOf(row: {
	workspaceId: string
	credentials: string | null
	dekCiphertext: string | null
}) {
	return decryptStoredCredential(kms, {
		workspaceId: row.workspaceId,
		credentials: row.credentials as string,
		dekCiphertext: row.dekCiphertext,
	})
}

const rotatedLog = (integrationId: string) =>
	db
		.select()
		.from(credentialAccessLog)
		.where(
			and(
				eq(credentialAccessLog.integrationId, integrationId),
				eq(credentialAccessLog.action, 'rotated'),
			),
		)

describe('rotateIntegrationDek', () => {
	it('re-wraps under a fresh DEK, keeps the decrypted value, and writes a rotated audit row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const before = await envelopeRow(ws.id, 'rot-a', 'secret-a')

		const out = await rotateIntegrationDek(db, kms, {
			integrationId: before.id,
			workspaceId: ws.id,
			actorId: getTestActorId(),
			origin: 'manual',
		})

		expect(out).toBe('rotated')
		const after = await reload(before.id)
		expect(after.dekCiphertext).not.toBe(before.dekCiphertext)
		expect(after.credentials).not.toBe(before.credentials)
		expect(await plaintextOf(after)).toBe('secret-a')
		const log = await rotatedLog(before.id)
		expect(log).toHaveLength(1)
		expect(log[0]?.actorId).toBe(getTestActorId())
		expect(log[0]?.requestId).toBe(`rotate-dek:manual:${before.id}`)
		expect((await verifyCredentialAccessChain(db, ws.id)).ok).toBe(true)
	})

	it('never touches a legacy row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const [legacy] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'rot-legacy',
				status: 'active',
				credentials: encrypt('secret-legacy'),
				dekCiphertext: null,
				createdBy: getTestActorId(),
			})
			.returning()
		const row = legacy as NonNullable<typeof legacy>

		const out = await rotateIntegrationDek(db, kms, {
			integrationId: row.id,
			workspaceId: ws.id,
			origin: 'manual',
		})

		expect(out).toBe('not_envelope')
		const after = await reload(row.id)
		expect(after.credentials).toBe(row.credentials)
		expect(after.dekCiphertext).toBeNull()
		expect(await rotatedLog(row.id)).toHaveLength(0)
	})

	it('is not_found for an unknown id and for another workspace', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		const row = await envelopeRow(ws.id, 'rot-scope', 'secret-scope')

		const wrongWorkspace = await rotateIntegrationDek(db, kms, {
			integrationId: row.id,
			workspaceId: other.id,
			origin: 'manual',
		})
		const unknown = await rotateIntegrationDek(db, kms, {
			integrationId: '00000000-0000-4000-8000-000000000000',
			workspaceId: ws.id,
			origin: 'manual',
		})

		expect(wrongWorkspace).toBe('not_found')
		expect(unknown).toBe('not_found')
		expect((await reload(row.id)).dekCiphertext).toBe(row.dekCiphertext)
	})

	it('does not overwrite a row another writer changed mid-rotation, and writes no audit row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await envelopeRow(ws.id, 'rot-race', 'secret-race')
		const winner = await encryptEnvelope(kms, ws.id, 'secret-race-rewritten')
		beforeEncrypt = async () => {
			await db
				.update(integrations)
				.set({ credentials: winner.credentials, dekCiphertext: winner.dekCiphertext })
				.where(eq(integrations.id, row.id))
			beforeEncrypt = undefined
		}

		const out = await rotateIntegrationDek(db, hooked, {
			integrationId: row.id,
			workspaceId: ws.id,
			origin: 'nightly',
		})

		expect(out).toBe('changed')
		expect(await plaintextOf(await reload(row.id))).toBe('secret-race-rewritten')
		expect(await rotatedLog(row.id)).toHaveLength(0)
	})
})

describe('POST /api/integrations/:id/rotate-dek', () => {
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
	const call = (app: ReturnType<typeof appFor>, workspaceId: string, id: string) =>
		app.request(`/api/integrations/${id}/rotate-dek`, {
			method: 'POST',
			headers: { 'x-workspace-id': workspaceId },
		})

	it('rotates for a workspace owner and returns the status', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await envelopeRow(ws.id, 'rot-http', 'secret-http')

		const res = await call(appFor(getTestActorId()), ws.id, row.id)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: row.id, status: 'rotated' })
		const after = await reload(row.id)
		expect(after.dekCiphertext).not.toBe(row.dekCiphertext)
		expect(await plaintextOf(after)).toBe('secret-http')
	})

	it('refuses an agent, even one that is a member of the workspace', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: agent.id, role: 'admin' })
		const row = await envelopeRow(ws.id, 'rot-agent', 'secret-agent')

		const res = await call(appFor(agent.id, 'agent'), ws.id, row.id)

		expect(res.status).toBe(403)
		expect((await reload(row.id)).dekCiphertext).toBe(row.dekCiphertext)
	})

	it('answers 404 for an unknown id and 409 for a legacy row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const [legacy] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'rot-http-legacy',
				status: 'active',
				credentials: encrypt('secret-legacy-http'),
				dekCiphertext: null,
				createdBy: getTestActorId(),
			})
			.returning()
		const app = appFor(getTestActorId())

		const missing = await call(app, ws.id, '00000000-0000-4000-8000-000000000000')
		const old = await call(app, ws.id, (legacy as NonNullable<typeof legacy>).id)

		expect(missing.status).toBe(404)
		expect(old.status).toBe(409)
	})
})

describe('RotateDeksJob', () => {
	async function readOnce(row: { id: string; workspaceId: string }) {
		await db.transaction((tx) =>
			insertCredentialAccessLog(tx, {
				workspaceId: row.workspaceId,
				integrationId: row.id,
				actorId: getTestActorId(),
				action: 'read',
				source: 'admin_ui',
				requestId: `test-read:${row.id}`,
			}),
		)
	}

	it('rotates credentials read in the last 24 hours and leaves unread ones alone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const read = await envelopeRow(ws.id, 'rot-job-read', 'secret-read')
		const unread = await envelopeRow(ws.id, 'rot-job-unread', 'secret-unread')
		await readOnce(read)

		const result = await new RotateDeksJob(db).run()

		expect(result.rotated).toBeGreaterThanOrEqual(1)
		const readAfter = await reload(read.id)
		expect(readAfter.dekCiphertext).not.toBe(read.dekCiphertext)
		expect(await plaintextOf(readAfter)).toBe('secret-read')
		const unreadAfter = await reload(unread.id)
		expect(unreadAfter.dekCiphertext).toBe(unread.dekCiphertext)
		expect(unreadAfter.credentials).toBe(unread.credentials)
		expect(await rotatedLog(read.id)).toHaveLength(1)
		expect(await rotatedLog(unread.id)).toHaveLength(0)
	})

	it('never selects a legacy row, even one that was read', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const [legacy] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'rot-job-legacy',
				status: 'active',
				credentials: encrypt('secret-legacy-job'),
				dekCiphertext: null,
				createdBy: getTestActorId(),
			})
			.returning()
		const row = legacy as NonNullable<typeof legacy>
		await readOnce(row)

		await new RotateDeksJob(db).run()

		const after = await reload(row.id)
		expect(after.credentials).toBe(row.credentials)
		expect(after.dekCiphertext).toBeNull()
	})

	it('carries on past a row that fails', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const good = await envelopeRow(ws.id, 'rot-job-good', 'secret-good')
		const [broken] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'rot-job-broken',
				status: 'active',
				credentials: 'not-a-ciphertext',
				dekCiphertext: 'not-a-wrapped-key',
				createdBy: getTestActorId(),
			})
			.returning()
		await readOnce(broken as NonNullable<typeof broken>)
		await readOnce(good)

		const result = await new RotateDeksJob(db).run()

		expect(result.failed).toBeGreaterThanOrEqual(1)
		expect((await reload(good.id)).dekCiphertext).not.toBe(good.dekCiphertext)
	})

	it('tick swallows a failing run', async () => {
		const spy = vi.spyOn(RotateDeksJob.prototype, 'run').mockRejectedValue(new Error('boom'))
		await expect(new RotateDeksJob(db).tick()).resolves.toBeUndefined()
		spy.mockRestore()
	})
})
