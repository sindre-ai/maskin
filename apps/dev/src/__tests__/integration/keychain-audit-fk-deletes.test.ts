import { randomBytes, randomUUID } from 'node:crypto'
import { MasterKeyProvider } from '@maskin/auth/kms'
import { actors, credentialAccessLog, integrations, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import {
	insertCredentialAccessLog,
	verifyCredentialAccessChain,
} from '../../lib/integrations/credential-audit'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * credential_access_log is insert-only, so a plain foreign key from it to an actor or
 * an integration makes that row undeletable once it has been read (FK 23503). The audit
 * log keeps the uuids as history instead. Against real Postgres because the failure is
 * a constraint, which a mocked DB cannot show.
 */

const KEY = `key_${'CANARY0123'.repeat(3)}`

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => setKmsProviderForTests(undefined))

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent', systemPrompt: 'Agent' })
	const { integrationId } = await createByoApiKey(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'Coolify',
		rawSecret: KEY,
	})
	await db.transaction((tx) =>
		insertCredentialAccessLog(tx, {
			workspaceId: ws.id,
			integrationId,
			actorId: agent.id,
			action: 'read',
			source: 'test',
			requestId: randomUUID(),
		}),
	)
	return { ws, human, agent, integrationId }
}

describe('audit log foreign keys (0094)', () => {
	it('deletes an agent that has read a credential, and keeps the audit row', async () => {
		const { ws, agent, integrationId } = await setup()

		await expect(db.delete(actors).where(eq(actors.id, agent.id))).resolves.toBeDefined()

		const rows = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, integrationId))
		expect(rows.some((r) => r.actorId === agent.id)).toBe(true)
		const chain = await verifyCredentialAccessChain(db, ws.id)
		expect(chain.ok).toBe(true)
	})

	it('deletes an integration that has audit rows, and keeps them', async () => {
		const { ws, integrationId } = await setup()

		await expect(
			db.delete(integrations).where(eq(integrations.id, integrationId)),
		).resolves.toBeDefined()

		const rows = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, integrationId))
		expect(rows.length).toBeGreaterThan(0)
		expect((await verifyCredentialAccessChain(db, ws.id)).ok).toBe(true)
	})

	it('deletes the session a key was captured in; the integration keeps working with no origin', async () => {
		const { ws, human, integrationId } = await setup()
		const session = await insertSession(db, ws.id, human, human)
		await db
			.update(integrations)
			.set({ originSessionId: session.id, source: 'chat_capture' })
			.where(eq(integrations.id, integrationId))

		await expect(db.delete(sessions).where(eq(sessions.id, session.id))).resolves.toBeDefined()

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row.originSessionId).toBeNull()
	})

	it('still refuses to delete a workspace that has an audit trail', async () => {
		const { ws } = await setup()
		const { workspaces } = await import('@maskin/db/schema')
		await expect(db.delete(workspaces).where(eq(workspaces.id, ws.id))).rejects.toThrow()
	})
})
