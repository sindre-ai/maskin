import { randomBytes } from 'node:crypto'
import { MasterKeyProvider } from '@maskin/auth/kms'
import { credentialAccessLog } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createByoLogin } from '../../lib/integrations/byo-login'
import { resolveKeychainTyping } from '../../lib/integrations/keychain-typing'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Obviously fake, built at runtime so no credential-shaped literal sits in the repo.
const USERNAME = `fake-user-${'0123456789'.repeat(2)}`
const PASSWORD = `fake-pass-${'abcdefghij'.repeat(2)}`

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => setKmsProviderForTests(undefined))

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const granted = await insertActor(db, { type: 'agent' })
	const stranger = await insertActor(db, { type: 'agent' })
	const { integrationId } = await createByoLogin(db, kms, {
		workspaceId: ws.id,
		actorId: human,
		displayName: 'Facebook',
		username: USERNAME,
		password: PASSWORD,
		agentIds: [granted.id],
	})
	const ctx = (actorId: string, actorType = 'agent') => ({
		workspaceId: ws.id,
		actorId,
		actorType,
	})
	return { ws, human, granted, stranger, integrationId, ctx }
}

describe('resolveKeychainTyping', () => {
	it('swaps in the real value for a granted agent and audits the read', async () => {
		const s = await setup()

		const password = await resolveKeychainTyping(
			db,
			s.ctx(s.granted.id),
			'{{keychain:Facebook.password}}',
		)
		expect(password).toEqual({
			kind: 'resolved',
			text: PASSWORD,
			credentialName: 'Facebook',
			field: 'password',
		})
		const username = await resolveKeychainTyping(
			db,
			s.ctx(s.granted.id),
			'{{keychain:Facebook.username}}',
		)
		expect(username).toMatchObject({ kind: 'resolved', text: USERNAME })

		const reads = await db
			.select()
			.from(credentialAccessLog)
			.where(
				and(
					eq(credentialAccessLog.integrationId, s.integrationId),
					eq(credentialAccessLog.action, 'read'),
				),
			)
		expect(reads).toHaveLength(2)
		expect(reads.every((r) => r.actorId === s.granted.id)).toBe(true)
		expect(reads.every((r) => r.outboundTarget === 'desktop:type')).toBe(true)
	})

	it('refuses an agent that has not been given the login, and reads nothing', async () => {
		const s = await setup()

		const result = await resolveKeychainTyping(
			db,
			s.ctx(s.stranger.id),
			'{{keychain:Facebook.password}}',
		)
		expect(result).toMatchObject({ kind: 'error', status: 403 })
		expect(JSON.stringify(result)).not.toContain(PASSWORD)

		const reads = await db
			.select()
			.from(credentialAccessLog)
			.where(
				and(
					eq(credentialAccessLog.integrationId, s.integrationId),
					eq(credentialAccessLog.action, 'read'),
				),
			)
		expect(reads).toHaveLength(0)
	})

	it('refuses a person', async () => {
		const s = await setup()
		const result = await resolveKeychainTyping(
			db,
			s.ctx(s.human, 'human'),
			'{{keychain:Facebook.password}}',
		)
		expect(result).toMatchObject({ kind: 'error', status: 403 })
	})

	it('refuses a reference with anything around it, so it cannot be wrapped in text that shows it', async () => {
		const s = await setup()
		for (const text of [
			'x{{keychain:Facebook.password}}',
			'{{keychain:Facebook.password}} ',
			'{{keychain:Facebook.password}}{{keychain:Facebook.username}}',
			'{{ keychain:Facebook.password }}',
		]) {
			const result = await resolveKeychainTyping(db, s.ctx(s.granted.id), text)
			expect(result, text).toMatchObject({ kind: 'error', status: 400 })
		}
	})

	it('404s a login that does not exist', async () => {
		const s = await setup()
		expect(
			await resolveKeychainTyping(db, s.ctx(s.granted.id), '{{keychain:Nope.password}}'),
		).toMatchObject({ kind: 'error', status: 404 })
	})

	it('leaves ordinary text alone', async () => {
		const s = await setup()
		expect(await resolveKeychainTyping(db, s.ctx(s.granted.id), 'hello world')).toEqual({
			kind: 'plain',
		})
	})
})
