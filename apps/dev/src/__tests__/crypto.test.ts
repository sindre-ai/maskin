import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KmsDecryptError, type KmsProvider, LocalFileKmsProvider } from '@maskin/auth/kms'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const TEST_KEY = 'a'.repeat(64) // 32 bytes in hex

describe('crypto', () => {
	let originalKey: string | undefined

	beforeEach(() => {
		originalKey = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY
	})

	afterEach(() => {
		if (originalKey !== undefined) {
			process.env.INTEGRATION_ENCRYPTION_KEY = originalKey
		} else {
			Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		}
	})

	it('encrypts and decrypts a string roundtrip', async () => {
		const { encrypt, decrypt } = await import('../lib/crypto')
		const plaintext = 'hello world secret data'
		const encrypted = encrypt(plaintext)
		const decrypted = decrypt(encrypted)
		expect(decrypted).toBe(plaintext)
	})

	it('produces different ciphertexts for the same plaintext (random IV)', async () => {
		const { encrypt } = await import('../lib/crypto')
		const plaintext = 'same input'
		const a = encrypt(plaintext)
		const b = encrypt(plaintext)
		expect(a).not.toBe(b)
	})

	it('rejects tampered ciphertext', async () => {
		const { encrypt, decrypt } = await import('../lib/crypto')
		const encrypted = encrypt('test data')
		// Flip a character in the encrypted portion
		const parts = encrypted.split(':')
		const part = parts[2] ?? ''
		parts[2] = `ff${part.slice(2)}`
		expect(() => decrypt(parts.join(':'))).toThrow()
	})

	it('rejects invalid ciphertext format', async () => {
		const { decrypt } = await import('../lib/crypto')
		expect(() => decrypt('not-valid-format')).toThrow('Invalid ciphertext format')
	})

	it('throws when INTEGRATION_ENCRYPTION_KEY is missing', async () => {
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		const { encrypt } = await import('../lib/crypto')
		expect(() => encrypt('test')).toThrow(
			'INTEGRATION_ENCRYPTION_KEY environment variable is required',
		)
	})

	it('throws when key is wrong length', async () => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'aabb' // only 2 bytes
		const { encrypt } = await import('../lib/crypto')
		expect(() => encrypt('test')).toThrow('32-byte')
	})
})

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'

describe('envelope encryption', () => {
	let originalKey: string | undefined
	let dir: string
	let kms: LocalFileKmsProvider

	beforeEach(() => {
		originalKey = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = TEST_KEY
		dir = mkdtempSync(join(tmpdir(), 'envelope-kek-'))
		kms = new LocalFileKmsProvider(join(dir, 'kek'))
	})

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		if (originalKey !== undefined) {
			process.env.INTEGRATION_ENCRYPTION_KEY = originalKey
		} else {
			Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		}
	})

	it.each([
		['1 KB', 1024],
		['100 KB', 100 * 1024],
	])('round-trips a %s payload', async (_label, size) => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		const plaintext = 'x'.repeat(size)
		const sealed = await encryptEnvelope(kms, WORKSPACE, plaintext)
		expect(sealed.credentials).not.toContain('xxxx')
		expect(await decryptEnvelope(kms, WORKSPACE, sealed.credentials, sealed.dekCiphertext)).toBe(
			plaintext,
		)
	})

	it('uses a fresh DEK per credential', async () => {
		const { encryptEnvelope } = await import('../lib/crypto')
		const a = await encryptEnvelope(kms, WORKSPACE, 'same')
		const b = await encryptEnvelope(kms, WORKSPACE, 'same')
		expect(a.dekCiphertext).not.toBe(b.dekCiphertext)
		expect(a.credentials).not.toBe(b.credentials)
	})

	it('does not depend on INTEGRATION_ENCRYPTION_KEY', async () => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'no legacy key needed')
		expect(await decryptEnvelope(kms, WORKSPACE, sealed.credentials, sealed.dekCiphertext)).toBe(
			'no legacy key needed',
		)
	})

	it('zeroises the DEK after encrypt and after decrypt', async () => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		const seen: Buffer[] = []
		const spy: KmsProvider = {
			encrypt: async (ws, dek) => {
				seen.push(dek)
				return kms.encrypt(ws, dek)
			},
			decrypt: async (ws, wrapped) => {
				const dek = await kms.decrypt(ws, wrapped)
				seen.push(dek)
				return dek
			},
		}
		const sealed = await encryptEnvelope(spy, WORKSPACE, 'secret')
		await decryptEnvelope(spy, WORKSPACE, sealed.credentials, sealed.dekCiphertext)
		expect(seen).toHaveLength(2)
		for (const dek of seen) expect(dek.equals(Buffer.alloc(32))).toBe(true)
	})

	it('zeroises the DEK even when decryption fails', async () => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'secret')
		const seen: Buffer[] = []
		const spy: KmsProvider = {
			encrypt: (ws, dek) => kms.encrypt(ws, dek),
			decrypt: async (ws, wrapped) => {
				const dek = await kms.decrypt(ws, wrapped)
				seen.push(dek)
				return dek
			},
		}
		const parts = sealed.credentials.split(':')
		parts[2] = `ff${(parts[2] ?? '').slice(2)}`
		await expect(
			decryptEnvelope(spy, WORKSPACE, parts.join(':'), sealed.dekCiphertext),
		).rejects.toThrow()
		expect(seen[0].equals(Buffer.alloc(32))).toBe(true)
	})

	it('rotates the DEK: new wrapped key, same plaintext, old envelope untouched', async () => {
		const { encryptEnvelope, decryptEnvelope, rotateEnvelopeDek } = await import('../lib/crypto')
		const a = await encryptEnvelope(kms, WORKSPACE, 'rotate me')
		const b = await rotateEnvelopeDek(kms, WORKSPACE, a.credentials, a.dekCiphertext)
		expect(b.dekCiphertext).not.toBe(a.dekCiphertext)
		expect(b.credentials).not.toBe(a.credentials)
		expect(await decryptEnvelope(kms, WORKSPACE, b.credentials, b.dekCiphertext)).toBe('rotate me')
		// DEK A cannot open the credential sealed under DEK B.
		await expect(decryptEnvelope(kms, WORKSPACE, b.credentials, a.dekCiphertext)).rejects.toThrow()
	})

	it('dual-read: a NULL dek_ciphertext row decrypts through the legacy key path', async () => {
		const { encrypt, decryptStoredCredential } = await import('../lib/crypto')
		const legacy = encrypt('{"accessToken":"fake-legacy-token"}')
		const value = await decryptStoredCredential(kms, {
			workspaceId: WORKSPACE,
			credentials: legacy,
			dekCiphertext: null,
		})
		expect(value).toBe('{"accessToken":"fake-legacy-token"}')
	})

	it('dual-read: once a row carries dek_ciphertext the legacy key is no longer consulted', async () => {
		const { encryptEnvelope, decryptStoredCredential } = await import('../lib/crypto')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'upgraded')
		process.env.INTEGRATION_ENCRYPTION_KEY = 'b'.repeat(64) // a different legacy key
		expect(await decryptStoredCredential(kms, { workspaceId: WORKSPACE, ...sealed })).toBe(
			'upgraded',
		)
	})

	it('a one-byte corruption of dek_ciphertext throws KmsDecryptError and returns nothing', async () => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'tamper target')
		const blob = Buffer.from(sealed.dekCiphertext, 'base64')
		blob[Math.floor(blob.length / 2)] ^= 0x01
		const result = decryptEnvelope(kms, WORKSPACE, sealed.credentials, blob.toString('base64'))
		await expect(result).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('a one-byte corruption of the credential ciphertext throws', async () => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'tamper target')
		const parts = sealed.credentials.split(':')
		const enc = Buffer.from(parts[2] ?? '', 'hex')
		enc[0] ^= 0x01
		parts[2] = enc.toString('hex')
		await expect(
			decryptEnvelope(kms, WORKSPACE, parts.join(':'), sealed.dekCiphertext),
		).rejects.toThrow()
	})

	it('a DEK wrapped for one workspace does not open in another', async () => {
		const { encryptEnvelope, decryptEnvelope } = await import('../lib/crypto')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'tenant a')
		await expect(
			decryptEnvelope(kms, OTHER_WORKSPACE, sealed.credentials, sealed.dekCiphertext),
		).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('rejects an unwrapped key of the wrong length', async () => {
		const { decryptEnvelope, encryptEnvelope } = await import('../lib/crypto')
		const sealed = await encryptEnvelope(kms, WORKSPACE, 'x')
		const shortKey: KmsProvider = {
			encrypt: (ws, dek) => kms.encrypt(ws, dek),
			decrypt: async () => randomBytes(16),
		}
		await expect(
			decryptEnvelope(shortKey, WORKSPACE, sealed.credentials, sealed.dekCiphertext),
		).rejects.toBeInstanceOf(KmsDecryptError)
	})
})
