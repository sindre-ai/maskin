import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
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

export function encrypt(plaintext: string): string {
	const key = getEncryptionKey()
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	const authTag = cipher.getAuthTag()
	return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(ciphertext: string): string {
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
