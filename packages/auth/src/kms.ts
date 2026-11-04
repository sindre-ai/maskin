import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Wraps and unwraps the per-credential data keys (DEKs) of envelope encryption.
 * The wrapped form is what lands in integrations.dek_ciphertext. Implementations
 * bind the wrapped key to the workspace, so a DEK wrapped for workspace A does
 * not unwrap for workspace B.
 */
export interface KmsProvider {
	/** Returns the wrapped DEK as a base64 string (dek_ciphertext). */
	encrypt(workspaceId: string, plaintext: Buffer): Promise<string>
	/** Returns the plaintext DEK. The caller zeroises it after use. */
	decrypt(workspaceId: string, ciphertext: string): Promise<Buffer>
}

/** The wrapped DEK did not unwrap: corrupted, truncated, or wrapped for another workspace. */
export class KmsDecryptError extends Error {
	constructor(message = 'Could not unwrap the data key', options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'KmsDecryptError'
	}
}

/** The master key is missing or malformed. */
export class KmsConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'KmsConfigError'
	}
}

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32

/**
 * Wraps DEKs with AES-256-GCM under one master key held in the environment
 * (KEYCHAIN_MASTER_KEY, 64 hex characters). The workspace id is the GCM additional
 * data, so a wrapped DEK only unwraps for its own workspace.
 *
 * The master key never touches the database: a copy of the database alone does not
 * decrypt a credential. Losing the master key loses every envelope credential, so
 * keep a copy in the secret store.
 *
 * Rotation: set the new key as KEYCHAIN_MASTER_KEY and the old one as
 * KEYCHAIN_MASTER_KEY_PREVIOUS. Unwrapping tries the current key first, then the
 * previous one. Wrapping always uses the current key, so the nightly DEK rotation
 * moves each credential over once it has been read. Drop the previous key when
 * nothing is left under it.
 */
export class MasterKeyProvider implements KmsProvider {
	constructor(
		private readonly key: Buffer,
		private readonly previousKey?: Buffer,
	) {
		for (const k of [key, previousKey]) {
			if (k && k.length !== KEY_LENGTH) {
				throw new KmsConfigError(`The Keychain master key must be ${KEY_LENGTH} bytes`)
			}
		}
	}

	async encrypt(workspaceId: string, plaintext: Buffer): Promise<string> {
		const iv = randomBytes(IV_LENGTH)
		const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH })
		cipher.setAAD(Buffer.from(workspaceId, 'utf8'))
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
		return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
	}

	async decrypt(workspaceId: string, ciphertext: string): Promise<Buffer> {
		const keys = this.previousKey ? [this.key, this.previousKey] : [this.key]
		let lastError: unknown
		for (const key of keys) {
			try {
				return unwrap(key, workspaceId, ciphertext)
			} catch (err) {
				lastError = err
			}
		}
		throw new KmsDecryptError('Could not unwrap the data key', { cause: lastError })
	}
}

function unwrap(key: Buffer, workspaceId: string, ciphertext: string): Buffer {
	const blob = Buffer.from(ciphertext, 'base64')
	if (blob.length <= IV_LENGTH + AUTH_TAG_LENGTH) throw new Error('wrapped key too short')
	const iv = blob.subarray(0, IV_LENGTH)
	const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
	const encrypted = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
	const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
	decipher.setAAD(Buffer.from(workspaceId, 'utf8'))
	decipher.setAuthTag(authTag)
	return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

function parseKey(name: string, raw: string): Buffer {
	const key = Buffer.from(raw.trim(), 'hex')
	if (key.length !== KEY_LENGTH || !/^[0-9a-fA-F]+$/.test(raw.trim())) {
		throw new KmsConfigError(
			`${name} must be ${KEY_LENGTH} bytes as ${KEY_LENGTH * 2} hex characters`,
		)
	}
	return key
}

/**
 * Builds the provider from the environment. Production needs KEYCHAIN_MASTER_KEY.
 * Elsewhere an unset key is derived from INTEGRATION_ENCRYPTION_KEY, which the dev
 * script already seeds, so a fresh checkout works with no extra setup. A malformed
 * key throws, so a typo stops the process instead of wrapping under a wrong key.
 */
export function createKmsProvider(
	env: Record<string, string | undefined> = process.env,
): KmsProvider {
	const raw = env.KEYCHAIN_MASTER_KEY?.trim()
	const rawPrevious = env.KEYCHAIN_MASTER_KEY_PREVIOUS?.trim()
	const previous = rawPrevious ? parseKey('KEYCHAIN_MASTER_KEY_PREVIOUS', rawPrevious) : undefined
	if (raw) return new MasterKeyProvider(parseKey('KEYCHAIN_MASTER_KEY', raw), previous)
	if (env.NODE_ENV === 'production') {
		throw new KmsConfigError('KEYCHAIN_MASTER_KEY must be set in production')
	}
	const seed = env.INTEGRATION_ENCRYPTION_KEY?.trim()
	if (!seed) {
		throw new KmsConfigError('Set KEYCHAIN_MASTER_KEY (or INTEGRATION_ENCRYPTION_KEY in dev)')
	}
	const derived = Buffer.from(
		hkdfSync(
			'sha256',
			parseKey('INTEGRATION_ENCRYPTION_KEY', seed),
			'',
			'maskin-keychain-master-v1',
			KEY_LENGTH,
		),
	)
	return new MasterKeyProvider(derived, previous)
}
