import { createDecipheriv } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const AUTH_TAG_LENGTH = 16

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
 * Mirrors `apps/dev/src/lib/crypto.ts#decrypt` so the notetaker extension can
 * read encrypted integration credentials without a reverse dependency on
 * apps/dev. Must stay in sync with the canonical implementation.
 */
export function decryptIntegrationCredentials(ciphertext: string): string {
	const key = getEncryptionKey()
	const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':')
	if (!ivHex || !authTagHex || !encryptedHex) {
		throw new Error('Invalid ciphertext format')
	}
	const iv = Buffer.from(ivHex, 'hex')
	const authTag = Buffer.from(authTagHex, 'hex')
	const encrypted = Buffer.from(encryptedHex, 'hex')
	const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
	decipher.setAuthTag(authTag)
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
	return decrypted.toString('utf8')
}
