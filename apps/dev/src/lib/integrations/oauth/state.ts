import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { decrypt } from '../../crypto'

/**
 * Compact codec for the OAuth `state` parameter.
 *
 * `crypto.ts`'s `encrypt()` emits `hex:hex:hex` — two characters per byte plus
 * two separators. That is fine for credentials at rest, but `state` has to
 * survive a round trip through the provider's own login flow, and at least one
 * provider (Ubersuggest, via `app.neilpatel.com`) stores it in a cookie while
 * it bounces the user through Google. Our state is embedded in that cookie
 * three times over (once in `next`, twice more inside a base64'd `xUbsData`
 * blob), so a 438-character hex envelope becomes ~3KB of cookie and trips the
 * 4KB per-cookie browser limit — the cookie is dropped and the provider
 * answers "`state` is missing or invalid". See the note in
 * `providers/ubersuggest/auth.ts`.
 *
 * Same AES-256-GCM construction, base64url instead: one concatenated buffer of
 * `iv || authTag || ciphertext`, which is roughly 45% of the hex size.
 */
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

export function encodeState(payload: unknown): string {
	const key = getEncryptionKey()
	const iv = randomBytes(IV_LENGTH)
	const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

/**
 * Decode a state produced by {@link encodeState}.
 *
 * Falls back to the legacy `hex:hex:hex` envelope so flows already in flight
 * when this ships (state is valid for 10 minutes) still complete instead of
 * failing with an opaque "Invalid state parameter" after the user has already
 * approved consent. Throws on anything that is neither.
 */
export function decodeState<T>(state: string): T {
	if (state.includes(':')) return JSON.parse(decrypt(state)) as T

	const key = getEncryptionKey()
	const buf = Buffer.from(state, 'base64url')
	if (buf.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
		throw new Error('Invalid state format')
	}
	const iv = buf.subarray(0, IV_LENGTH)
	const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
	const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
	const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
	decipher.setAuthTag(authTag)
	const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
	return JSON.parse(decrypted.toString('utf8')) as T
}
