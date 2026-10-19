import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { KmsConfigError, KmsDecryptError, MasterKeyProvider, createKmsProvider } from '../kms'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'
const hex = () => randomBytes(32).toString('hex')

describe('MasterKeyProvider', () => {
	it('wraps and unwraps a data key', async () => {
		const kms = new MasterKeyProvider(randomBytes(32))
		const dek = randomBytes(32)

		const wrapped = await kms.encrypt(WORKSPACE, dek)

		expect((await kms.decrypt(WORKSPACE, wrapped)).equals(dek)).toBe(true)
	})

	it('does not unwrap for another workspace', async () => {
		const kms = new MasterKeyProvider(randomBytes(32))
		const wrapped = await kms.encrypt(WORKSPACE, randomBytes(32))

		await expect(kms.decrypt(OTHER_WORKSPACE, wrapped)).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('does not unwrap under a different master key', async () => {
		const wrapped = await new MasterKeyProvider(randomBytes(32)).encrypt(WORKSPACE, randomBytes(32))

		await expect(
			new MasterKeyProvider(randomBytes(32)).decrypt(WORKSPACE, wrapped),
		).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('rejects a truncated or corrupted wrapped key', async () => {
		const kms = new MasterKeyProvider(randomBytes(32))
		const wrapped = Buffer.from(await kms.encrypt(WORKSPACE, randomBytes(32)), 'base64')
		wrapped[wrapped.length - 1] ^= 0xff

		await expect(kms.decrypt(WORKSPACE, wrapped.toString('base64'))).rejects.toBeInstanceOf(
			KmsDecryptError,
		)
		await expect(kms.decrypt(WORKSPACE, 'AAAA')).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('unwraps a key wrapped under the previous master key, and wraps under the current one', async () => {
		const oldKey = randomBytes(32)
		const newKey = randomBytes(32)
		const dek = randomBytes(32)
		const wrappedOld = await new MasterKeyProvider(oldKey).encrypt(WORKSPACE, dek)
		const rotating = new MasterKeyProvider(newKey, oldKey)

		expect((await rotating.decrypt(WORKSPACE, wrappedOld)).equals(dek)).toBe(true)

		const rewrapped = await rotating.encrypt(WORKSPACE, dek)
		expect((await new MasterKeyProvider(newKey).decrypt(WORKSPACE, rewrapped)).equals(dek)).toBe(
			true,
		)
	})

	it('rejects a master key of the wrong length', () => {
		expect(() => new MasterKeyProvider(randomBytes(16))).toThrow(KmsConfigError)
	})
})

describe('createKmsProvider', () => {
	it('uses KEYCHAIN_MASTER_KEY', async () => {
		const key = hex()
		const a = createKmsProvider({ KEYCHAIN_MASTER_KEY: key })
		const b = createKmsProvider({ KEYCHAIN_MASTER_KEY: key })
		const wrapped = await a.encrypt(WORKSPACE, randomBytes(32))

		await expect(b.decrypt(WORKSPACE, wrapped)).resolves.toBeInstanceOf(Buffer)
	})

	it('reads the previous key from KEYCHAIN_MASTER_KEY_PREVIOUS', async () => {
		const oldKey = hex()
		const wrapped = await createKmsProvider({ KEYCHAIN_MASTER_KEY: oldKey }).encrypt(
			WORKSPACE,
			randomBytes(32),
		)
		const rotating = createKmsProvider({
			KEYCHAIN_MASTER_KEY: hex(),
			KEYCHAIN_MASTER_KEY_PREVIOUS: oldKey,
		})

		await expect(rotating.decrypt(WORKSPACE, wrapped)).resolves.toBeInstanceOf(Buffer)
	})

	it('throws in production when KEYCHAIN_MASTER_KEY is unset, even if INTEGRATION_ENCRYPTION_KEY is set', () => {
		expect(() =>
			createKmsProvider({ NODE_ENV: 'production', INTEGRATION_ENCRYPTION_KEY: hex() }),
		).toThrow(KmsConfigError)
	})

	it('derives a stable key from INTEGRATION_ENCRYPTION_KEY outside production', async () => {
		const seed = hex()
		const wrapped = await createKmsProvider({ INTEGRATION_ENCRYPTION_KEY: seed }).encrypt(
			WORKSPACE,
			randomBytes(32),
		)

		await expect(
			createKmsProvider({ INTEGRATION_ENCRYPTION_KEY: seed }).decrypt(WORKSPACE, wrapped),
		).resolves.toBeInstanceOf(Buffer)
		await expect(
			createKmsProvider({ INTEGRATION_ENCRYPTION_KEY: hex() }).decrypt(WORKSPACE, wrapped),
		).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('throws when no key is available at all', () => {
		expect(() => createKmsProvider({})).toThrow(KmsConfigError)
	})

	it.each(['xyz', 'ab'.repeat(16), 'zz'.repeat(32)])('rejects a malformed key %s', (bad) => {
		expect(() => createKmsProvider({ KEYCHAIN_MASTER_KEY: bad })).toThrow(KmsConfigError)
	})
})
