import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type KmsProvider, MasterKeyProvider } from '@maskin/auth/kms'
import { integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
	LEGACY_UPGRADE_DENY_LIST,
	UpgradeLegacyCredentialsJob,
	isLegacyUpgradeEnabled,
} from '../../jobs/upgrade-legacy-credentials'
import { decryptStoredCredential, encrypt } from '../../lib/crypto'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

let dir: string
let kms: MasterKeyProvider
const kmsCalls = { encrypt: 0, decrypt: 0 }
let beforeEncrypt: ((workspaceId: string) => Promise<void>) | undefined

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'legacy-upgrade-kek-'))
	kms = new MasterKeyProvider(randomBytes(32))
	// Counts calls, and lets a test run a concurrent write in the middle of a row's upgrade.
	const counting: KmsProvider = {
		async encrypt(workspaceId, plaintext) {
			kmsCalls.encrypt++
			await beforeEncrypt?.(workspaceId)
			return kms.encrypt(workspaceId, plaintext)
		},
		async decrypt(workspaceId, ciphertext) {
			kmsCalls.decrypt++
			return kms.decrypt(workspaceId, ciphertext)
		},
	}
	setKmsProviderForTests(counting)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})

const on = (batchSize?: number) =>
	new UpgradeLegacyCredentialsJob(db, '43 3 * * *', batchSize, () => true)
const off = () => new UpgradeLegacyCredentialsJob(db, '43 3 * * *', 100, () => false)

async function legacyRow(workspaceId: string, provider: string, plaintext: string) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status: 'active',
			credentials: encrypt(plaintext),
			dekCiphertext: null,
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

describe('isLegacyUpgradeEnabled', () => {
	it('is off unless the variable is exactly "true"', () => {
		expect(isLegacyUpgradeEnabled({})).toBe(false)
		expect(isLegacyUpgradeEnabled({ KEYCHAIN_LEGACY_UPGRADE_ENABLED: '' })).toBe(false)
		expect(isLegacyUpgradeEnabled({ KEYCHAIN_LEGACY_UPGRADE_ENABLED: 'false' })).toBe(false)
		expect(isLegacyUpgradeEnabled({ KEYCHAIN_LEGACY_UPGRADE_ENABLED: '1' })).toBe(false)
		expect(isLegacyUpgradeEnabled({ KEYCHAIN_LEGACY_UPGRADE_ENABLED: 'true' })).toBe(true)
	})
})

describe('UpgradeLegacyCredentialsJob', () => {
	it('gate off: changes no row and makes no KMS call', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await legacyRow(ws.id, 'upg-off', 'secret-off')
		kmsCalls.encrypt = 0
		kmsCalls.decrypt = 0

		const result = await off().run()

		expect(result).toEqual({ enabled: false, upgraded: 0, skipped: 0, failed: 0 })
		const after = await reload(row.id)
		expect(after.credentials).toBe(row.credentials)
		expect(after.dekCiphertext).toBeNull()
		expect(kmsCalls).toEqual({ encrypt: 0, decrypt: 0 })
	})

	it('gate on: upgrades a legacy row and the decrypted value is identical', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const before = await legacyRow(ws.id, 'upg-on', 'secret-on')

		const result = await on().run()

		expect(result.enabled).toBe(true)
		expect(result.upgraded).toBeGreaterThanOrEqual(1)
		const after = await reload(before.id)
		expect(after.dekCiphertext).toBeTruthy()
		expect(after.credentials).not.toBe(before.credentials)
		const value = await decryptStoredCredential(kms, {
			workspaceId: ws.id,
			credentials: after.credentials as string,
			dekCiphertext: after.dekCiphertext,
		})
		expect(value).toBe('secret-on')
	})

	it('leaves rows that already have a dek_ciphertext alone', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const [row] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'upg-envelope',
				status: 'active',
				credentials: 'already-an-envelope',
				dekCiphertext: 'already-wrapped',
				createdBy: getTestActorId(),
			})
			.returning()

		await on().run()

		const after = await reload((row as { id: string }).id)
		expect(after.credentials).toBe('already-an-envelope')
		expect(after.dekCiphertext).toBe('already-wrapped')
	})

	it.each(LEGACY_UPGRADE_DENY_LIST)(
		'skips a legacy %s row even with the gate on, while another provider still upgrades',
		async (provider) => {
			const ws = await insertWorkspace(db, getTestActorId())
			const denied = await legacyRow(ws.id, provider, `secret-${provider}`)
			const allowed = await legacyRow(ws.id, 'upg-allowed', 'secret-allowed')

			await on().run()

			const deniedAfter = await reload(denied.id)
			expect(deniedAfter.credentials).toBe(denied.credentials)
			expect(deniedAfter.dekCiphertext).toBeNull()
			expect((await reload(allowed.id)).dekCiphertext).toBeTruthy()
		},
	)

	it('the deny-list names at least google-meet and linkedin-unipile', () => {
		expect(LEGACY_UPGRADE_DENY_LIST).toEqual(
			expect.arrayContaining(['google-meet', 'linkedin-unipile']),
		)
	})

	it('does not overwrite a row that a legacy writer changed mid-upgrade', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await legacyRow(ws.id, 'upg-race', 'secret-before')
		const refreshed = encrypt('secret-after-refresh')
		// A token refresh lands between the job's read and its write.
		beforeEncrypt = async (workspaceId) => {
			if (workspaceId !== ws.id) return
			await db
				.update(integrations)
				.set({ credentials: refreshed })
				.where(eq(integrations.id, row.id))
			beforeEncrypt = undefined
		}

		const result = await on().run()

		expect(result.skipped).toBeGreaterThanOrEqual(1)
		const after = await reload(row.id)
		expect(after.credentials).toBe(refreshed)
		expect(after.dekCiphertext).toBeNull()
	})

	it('counts a row it cannot decrypt as failed and carries on with the rest', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const [broken] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'upg-broken',
				status: 'active',
				credentials: 'not-a-legacy-ciphertext',
				dekCiphertext: null,
				createdBy: getTestActorId(),
			})
			.returning()
		const good = await legacyRow(ws.id, 'upg-good', 'secret-good')

		const result = await on().run()

		expect(result.failed).toBeGreaterThanOrEqual(1)
		expect((await reload((broken as { id: string }).id)).dekCiphertext).toBeNull()
		expect((await reload(good.id)).dekCiphertext).toBeTruthy()
	})

	it('walks more rows than one batch', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const rows = [
			await legacyRow(ws.id, 'upg-page-1', 'p1'),
			await legacyRow(ws.id, 'upg-page-2', 'p2'),
			await legacyRow(ws.id, 'upg-page-3', 'p3'),
		]

		await on(1).run()

		for (const r of rows) expect((await reload(r.id)).dekCiphertext).toBeTruthy()
	})

	it('tick swallows a failing run', async () => {
		const spy = vi
			.spyOn(UpgradeLegacyCredentialsJob.prototype, 'run')
			.mockRejectedValue(new Error('boom'))
		await expect(on().tick()).resolves.toBeUndefined()
		spy.mockRestore()
	})
})
