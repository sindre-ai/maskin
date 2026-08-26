import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
export const IV_LENGTH = 12
export const AUTH_TAG_LENGTH = 16

function getEncryptionKey(): Buffer {
	const key = process.env.INTEGRATION_ENCRYPTION_KEY
	if (!key) {
		throw new Error('INTEGRATION_ENCRYPTION_KEY environment variable is required')
	}
	const buf = Buffer.from(key, 'hex')
	if (buf.length !== 32) {
		throw new Error('INTEGRATION_ENCRYPTION_KEY must be a 32-byte (64 hex character) string')
	}
	return buf
}

/**
 * AES-256-GCM encrypt, returning the raw parts rather than a serialized string.
 *
 * Callers choose their own envelope: {@link encrypt} uses `hex:hex:hex`, while
 * `integrations/oauth/state.ts` concatenates to base64url because the OAuth
 * `state` parameter has to survive length-constrained provider cookies. Keeping
 * the key handling and cipher construction here means the two envelopes cannot
 * drift apart.
 */
export function seal(plaintext: string): { iv: Buffer; authTag: Buffer; encrypted: Buffer } {
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	return { iv, authTag: cipher.getAuthTag(), encrypted }
}

/** Inverse of {@link seal}. Throws if the auth tag does not verify. */
export function open(iv: Buffer, authTag: Buffer, encrypted: Buffer): string {
	const decipher = createDecipheriv(ALGORITHM, getEncryptionKey(), iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	decipher.setAuthTag(authTag)
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

export function encrypt(plaintext: string): string {
	const { iv, authTag, encrypted } = seal(plaintext)
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(ciphertext: string): string {
	const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':')
	if (!ivHex || !authTagHex || !encryptedHex) {
		throw new Error('Invalid ciphertext format')
	}
	return open(
		Buffer.from(ivHex, 'hex'),
		Buffer.from(authTagHex, 'hex'),
		Buffer.from(encryptedHex, 'hex'),
	)
}
