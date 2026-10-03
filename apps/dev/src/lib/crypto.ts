import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { KmsDecryptError, type KmsProvider } from '@maskin/auth'

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
	return sealWithKey(plaintext, getEncryptionKey())
}

function sealWithKey(
	plaintext: string,
	key: Buffer,
): { iv: Buffer; authTag: Buffer; encrypted: Buffer } {
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALGORITHM, key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	return { iv, authTag: cipher.getAuthTag(), encrypted }
}

/** Inverse of {@link seal}. Throws if the auth tag does not verify. */
export function open(iv: Buffer, authTag: Buffer, encrypted: Buffer): string {
	return openWithKey(iv, authTag, encrypted, getEncryptionKey())
}

function openWithKey(iv: Buffer, authTag: Buffer, encrypted: Buffer, key: Buffer): string {
	const decipher = createDecipheriv(ALGORITHM, key, iv, {
		authTagLength: AUTH_TAG_LENGTH,
	})
	decipher.setAuthTag(authTag)
	return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

function serialize(parts: { iv: Buffer; authTag: Buffer; encrypted: Buffer }): string {
	return `${parts.iv.toString('hex')}:${parts.authTag.toString('hex')}:${parts.encrypted.toString('hex')}`
}

function parse(ciphertext: string): { iv: Buffer; authTag: Buffer; encrypted: Buffer } {
	const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':')
	if (!ivHex || !authTagHex || !encryptedHex) {
		throw new Error('Invalid ciphertext format')
	}
	return {
		iv: Buffer.from(ivHex, 'hex'),
		authTag: Buffer.from(authTagHex, 'hex'),
		encrypted: Buffer.from(encryptedHex, 'hex'),
	}
}

export function encrypt(plaintext: string): string {
	return serialize(seal(plaintext))
}

export function decrypt(ciphertext: string): string {
	const { iv, authTag, encrypted } = parse(ciphertext)
	return open(iv, authTag, encrypted)
}

// ── Envelope encryption (Keychain) ──────────────────────────────────────────
//
// Each credential gets its own random 32-byte data key (DEK). The credential is
// AES-256-GCM encrypted under the DEK and stored in integrations.credentials in
// the same iv:tag:ciphertext format as the legacy path; the DEK, wrapped by the
// workspace KEK in KMS, is stored in integrations.dek_ciphertext. The DEK in the
// clear exists only inside these functions and is zeroised before they return,
// on every path including errors.

export const DEK_LENGTH = 32

export interface EnvelopeCiphertext {
	/** Goes in integrations.credentials. */
	credentials: string
	/** Goes in integrations.dek_ciphertext. */
	dekCiphertext: string
}

export async function encryptEnvelope(
	kms: KmsProvider,
	workspaceId: string,
	plaintext: string,
): Promise<EnvelopeCiphertext> {
	const dek = randomBytes(DEK_LENGTH)
	try {
		const dekCiphertext = await kms.encrypt(workspaceId, dek)
		return { credentials: serialize(sealWithKey(plaintext, dek)), dekCiphertext }
	} finally {
		dek.fill(0)
	}
}

/**
 * Throws KmsDecryptError if the wrapped DEK does not unwrap (corrupted, or
 * wrapped for another workspace) and the underlying GCM error if the credential
 * ciphertext does not authenticate. Never returns partial plaintext.
 */
export async function decryptEnvelope(
	kms: KmsProvider,
	workspaceId: string,
	credentials: string,
	dekCiphertext: string,
): Promise<string> {
	const dek = await kms.decrypt(workspaceId, dekCiphertext)
	try {
		if (dek.length !== DEK_LENGTH) {
			throw new KmsDecryptError('Unwrapped data key has the wrong length')
		}
		const { iv, authTag, encrypted } = parse(credentials)
		return openWithKey(iv, authTag, encrypted, dek)
	} finally {
		dek.fill(0)
	}
}

/**
 * Re-encrypts under a fresh DEK. The old DEK is unwrapped only to decrypt, then
 * zeroised; nothing of it survives in the returned value.
 */
export async function rotateEnvelopeDek(
	kms: KmsProvider,
	workspaceId: string,
	credentials: string,
	dekCiphertext: string,
): Promise<EnvelopeCiphertext> {
	const plaintext = await decryptEnvelope(kms, workspaceId, credentials, dekCiphertext)
	return encryptEnvelope(kms, workspaceId, plaintext)
}

/**
 * Dual-read. A row with no dek_ciphertext predates Keychain and decrypts under
 * INTEGRATION_ENCRYPTION_KEY; every other row is an envelope.
 */
export async function decryptStoredCredential(
	kms: KmsProvider,
	row: { workspaceId: string; credentials: string; dekCiphertext: string | null },
): Promise<string> {
	if (row.dekCiphertext === null) return decrypt(row.credentials)
	return decryptEnvelope(kms, row.workspaceId, row.credentials, row.dekCiphertext)
}
