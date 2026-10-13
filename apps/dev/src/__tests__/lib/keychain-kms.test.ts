import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../lib/logger', () => ({ logger }))

import { prepareLocalKek, setKmsProviderForTests } from '../../lib/keychain-kms'

// The provider asks the database whether any credential is already wrapped.
const dbWithWrappedKeys = (wrapped: boolean) =>
	({
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => (wrapped ? [{ id: 'row' }] : []) }) }),
		}),
	}) as unknown as Database

describe('prepareLocalKek', () => {
	let dir: string
	const saved = { ...process.env }

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'keychain-kms-'))
		setKmsProviderForTests(undefined)
		logger.info.mockClear()
		logger.error.mockClear()
	})

	afterEach(() => {
		process.env = { ...saved }
		rmSync(dir, { recursive: true, force: true })
	})

	it('does nothing, and does not throw, in production with KEYCHAIN_KMS unset', async () => {
		// Assigning undefined to a process.env key stores the string "undefined".
		const { KEYCHAIN_KMS: _unset, ...rest } = saved
		const kek = join(dir, 'kek')
		process.env = { ...rest, NODE_ENV: 'production', KEYCHAIN_LOCAL_KEK_FILE: kek }

		await expect(prepareLocalKek(dbWithWrappedKeys(false))).resolves.toBeUndefined()
		expect(existsSync(kek)).toBe(false)
	})

	it('does nothing outside production', async () => {
		process.env.NODE_ENV = 'test'
		process.env.KEYCHAIN_KMS = 'local-file'
		const kek = join(dir, 'kek')
		process.env.KEYCHAIN_LOCAL_KEK_FILE = kek

		await prepareLocalKek(dbWithWrappedKeys(false))
		expect(existsSync(kek)).toBe(false)
	})

	it('creates the KEK and logs a fingerprint in production under local-file', async () => {
		process.env.NODE_ENV = 'production'
		process.env.KEYCHAIN_KMS = 'local-file'
		const kek = join(dir, 'kek')
		process.env.KEYCHAIN_LOCAL_KEK_FILE = kek

		await prepareLocalKek(dbWithWrappedKeys(false))
		expect(existsSync(kek)).toBe(true)
		expect(logger.info).toHaveBeenCalledWith(
			'Keychain KEK (local-file)',
			expect.objectContaining({
				kekFileExisted: false,
				kekFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
			}),
		)
	})

	it('refuses to create a new KEK when credentials are already wrapped, logs, and lets boot continue', async () => {
		process.env.NODE_ENV = 'production'
		process.env.KEYCHAIN_KMS = 'local-file'
		const kek = join(dir, 'kek')
		process.env.KEYCHAIN_LOCAL_KEK_FILE = kek

		await expect(prepareLocalKek(dbWithWrappedKeys(true))).resolves.toBeUndefined()
		expect(existsSync(kek)).toBe(false)
		expect(logger.error).toHaveBeenCalledWith(
			'Keychain KEK (local-file) is not available',
			expect.objectContaining({ error: expect.stringContaining('refusing to create a new one') }),
		)
	})
})
