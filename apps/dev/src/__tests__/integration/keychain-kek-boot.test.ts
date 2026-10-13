import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KmsKekMissingError, createKmsProvider } from '@maskin/auth/kms'
import { integrations } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encryptEnvelope } from '../../lib/crypto'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// The lost-volume guard is a real query on integrations.dek_ciphertext, so it is
// checked against Postgres here and not against a mocked builder.
describe('Local KEK guard (real database)', () => {
	let dir: string
	let kekPath: string

	const provider = () =>
		createKmsProvider(db, { KEYCHAIN_KMS: 'local-file', KEYCHAIN_LOCAL_KEK_FILE: kekPath })

	beforeEach(async () => {
		await sql`DELETE FROM integrations`
		dir = mkdtempSync(join(tmpdir(), 'keychain-kek-boot-'))
		kekPath = join(dir, 'kek')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	async function insertRow(opts: { envelope: boolean }) {
		const ws = await insertWorkspace(db, getTestActorId())
		const sealed = opts.envelope
			? await encryptEnvelope(provider(), ws.id, 'fake-secret')
			: { credentials: 'legacy-ciphertext', dekCiphertext: null }
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'fake-provider',
			status: 'active',
			credentials: sealed.credentials,
			dekCiphertext: sealed.dekCiphertext,
			createdBy: getTestActorId(),
		})
	}

	it('creates the KEK when nothing is wrapped, and a second boot finds it', async () => {
		const first = await provider().prepare()
		expect(first.existed).toBe(false)
		expect(existsSync(kekPath)).toBe(true)
		const second = await provider().prepare()
		expect(second).toEqual({ existed: true, fingerprint: first.fingerprint })
	})

	it('refuses to create a new KEK when an envelope row exists, and writes no file', async () => {
		await insertRow({ envelope: true })
		rmSync(kekPath)

		await expect(provider().prepare()).rejects.toBeInstanceOf(KmsKekMissingError)
		expect(existsSync(kekPath)).toBe(false)
	})

	it('still reads an existing KEK file when an envelope row exists', async () => {
		await insertRow({ envelope: true })
		const status = await provider().prepare()
		expect(status.existed).toBe(true)
	})

	it('a legacy row (no dek_ciphertext) does not block creating the KEK', async () => {
		await insertRow({ envelope: false })
		const status = await provider().prepare()
		expect(status.existed).toBe(false)
		expect(existsSync(kekPath)).toBe(true)
	})
})
