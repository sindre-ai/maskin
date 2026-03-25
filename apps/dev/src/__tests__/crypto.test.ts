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
