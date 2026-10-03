import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
	CreateAliasCommand,
	CreateKeyCommand,
	DecryptCommand,
	DescribeKeyCommand,
	EncryptCommand,
	KMSClient,
} from '@aws-sdk/client-kms'
import type { Database } from '@maskin/db'
import { workspaceKmsAliases } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'

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

/** KMS refused the call (AccessDenied or equivalent). Never degrade this to a null. */
export class KmsAccessError extends Error {
	constructor(message = 'KMS denied access', options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'KmsAccessError'
	}
}

/** KEYCHAIN_KMS is unset where it is required, or names a provider that does not exist. */
export class KmsConfigError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'KmsConfigError'
	}
}

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEK_LENGTH = 32
const DEFAULT_KEK_FILE = '.data/keychain-kek'

// ── Local file ──────────────────────────────────────────────────────────────

/**
 * Dev and self-host provider: AES-256-GCM under a KEK held in a local file
 * (KEYCHAIN_LOCAL_KEK_FILE, default .data/keychain-kek), generated with 0600
 * permissions on first use. The file is the root of trust for this provider:
 * lose it and every credential wrapped under it is unrecoverable.
 */
export class LocalFileKmsProvider implements KmsProvider {
	private kek: Promise<Buffer> | undefined

	constructor(private readonly path: string = DEFAULT_KEK_FILE) {}

	private loadKek(): Promise<Buffer> {
		// Cache the promise, not the value, so concurrent first calls share one load.
		this.kek ??= this.readOrCreateKek()
		return this.kek
	}

	private async readOrCreateKek(): Promise<Buffer> {
		try {
			return parseKek(await readFile(this.path, 'utf8'), this.path)
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
		}
		await mkdir(dirname(this.path), { recursive: true })
		try {
			// 'wx' fails if another process created the file first; we then read theirs.
			await writeFile(this.path, randomBytes(KEK_LENGTH).toString('hex'), {
				mode: 0o600,
				flag: 'wx',
			})
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
		}
		await chmod(this.path, 0o600)
		return parseKek(await readFile(this.path, 'utf8'), this.path)
	}

	async encrypt(workspaceId: string, plaintext: Buffer): Promise<string> {
		const kek = await this.loadKek()
		const iv = randomBytes(IV_LENGTH)
		const cipher = createCipheriv(ALGORITHM, kek, iv, { authTagLength: AUTH_TAG_LENGTH })
		cipher.setAAD(Buffer.from(workspaceId, 'utf8'))
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
		return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
	}

	async decrypt(workspaceId: string, ciphertext: string): Promise<Buffer> {
		const kek = await this.loadKek()
		try {
			const blob = Buffer.from(ciphertext, 'base64')
			if (blob.length <= IV_LENGTH + AUTH_TAG_LENGTH) throw new Error('wrapped key too short')
			const iv = blob.subarray(0, IV_LENGTH)
			const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
			const encrypted = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH)
			const decipher = createDecipheriv(ALGORITHM, kek, iv, { authTagLength: AUTH_TAG_LENGTH })
			decipher.setAAD(Buffer.from(workspaceId, 'utf8'))
			decipher.setAuthTag(authTag)
			return Buffer.concat([decipher.update(encrypted), decipher.final()])
		} catch (err) {
			throw new KmsDecryptError('Could not unwrap the data key', { cause: err })
		}
	}
}

function parseKek(contents: string, path: string): Buffer {
	const kek = Buffer.from(contents.trim(), 'hex')
	if (kek.length !== KEK_LENGTH) {
		throw new KmsConfigError(`KEK file ${path} must hold ${KEK_LENGTH} bytes as hex`)
	}
	return kek
}

// ── AWS KMS ─────────────────────────────────────────────────────────────────

export interface AwsKmsProviderOptions {
	db: Database
	region?: string
	/** Injected in tests; defaults to a real client for `region`. */
	client?: KMSClient
}

const aliasFor = (workspaceId: string) => `alias/maskin-keychain-${workspaceId}`

function awsErrorName(err: unknown): string {
	return err instanceof Error ? err.name : ''
}

/**
 * Production provider. One KMS key per workspace behind the alias
 * alias/maskin-keychain-<workspaceId>, provisioned on the workspace's first
 * write. The workspace id travels as KMS encryption context on every call, so a
 * wrapped DEK only unwraps for its own workspace and CloudTrail records which
 * workspace each Decrypt was for.
 */
export class AwsKmsProvider implements KmsProvider {
	private readonly client: KMSClient
	private readonly db: Database
	private readonly provisioning = new Map<string, Promise<string>>()

	constructor(opts: AwsKmsProviderOptions) {
		this.db = opts.db
		this.client = opts.client ?? new KMSClient({ region: opts.region })
	}

	async encrypt(workspaceId: string, plaintext: Buffer): Promise<string> {
		const alias = await this.ensureAlias(workspaceId)
		try {
			const out = await this.client.send(
				new EncryptCommand({
					KeyId: alias,
					Plaintext: plaintext,
					EncryptionContext: { workspace_id: workspaceId },
				}),
			)
			if (!out.CiphertextBlob) throw new KmsAccessError('KMS Encrypt returned no ciphertext')
			return Buffer.from(out.CiphertextBlob).toString('base64')
		} catch (err) {
			throw this.mapError(err)
		}
	}

	async decrypt(workspaceId: string, ciphertext: string): Promise<Buffer> {
		const alias = await this.lookupAlias(workspaceId)
		if (!alias) throw new KmsDecryptError(`No KMS alias for workspace ${workspaceId}`)
		try {
			const out = await this.client.send(
				new DecryptCommand({
					CiphertextBlob: Buffer.from(ciphertext, 'base64'),
					KeyId: alias,
					EncryptionContext: { workspace_id: workspaceId },
				}),
			)
			if (!out.Plaintext) throw new KmsDecryptError('KMS Decrypt returned no plaintext')
			return Buffer.from(out.Plaintext)
		} catch (err) {
			throw this.mapError(err)
		}
	}

	private mapError(err: unknown): Error {
		if (err instanceof KmsAccessError || err instanceof KmsDecryptError) return err
		const name = awsErrorName(err)
		if (name === 'AccessDeniedException' || name === 'AccessDenied') {
			return new KmsAccessError('KMS denied access', { cause: err })
		}
		if (
			name === 'InvalidCiphertextException' ||
			name === 'IncorrectKeyException' ||
			name === 'InvalidKeyUsageException'
		) {
			return new KmsDecryptError('Could not unwrap the data key', { cause: err })
		}
		return err instanceof Error ? err : new Error(String(err))
	}

	private async lookupAlias(workspaceId: string): Promise<string | undefined> {
		const [row] = await this.db
			.select({ kekAlias: workspaceKmsAliases.kekAlias })
			.from(workspaceKmsAliases)
			.where(eq(workspaceKmsAliases.workspaceId, workspaceId))
			.limit(1)
		return row?.kekAlias
	}

	/**
	 * Idempotent and retry-safe: the alias name is deterministic, the table row is
	 * written ON CONFLICT DO NOTHING, an alias that already exists in KMS is
	 * adopted, and concurrent callers in this process share one provisioning run.
	 */
	private ensureAlias(workspaceId: string): Promise<string> {
		const inflight = this.provisioning.get(workspaceId)
		if (inflight) return inflight
		const run = this.provision(workspaceId).finally(() => this.provisioning.delete(workspaceId))
		this.provisioning.set(workspaceId, run)
		return run
	}

	private async provision(workspaceId: string): Promise<string> {
		const existing = await this.lookupAlias(workspaceId)
		if (existing) return existing

		const alias = aliasFor(workspaceId)
		try {
			await this.client.send(new DescribeKeyCommand({ KeyId: alias }))
		} catch (err) {
			if (awsErrorName(err) !== 'NotFoundException') throw this.mapError(err)
			const created = await this.client
				.send(
					new CreateKeyCommand({
						Description: `Maskin Keychain KEK for workspace ${workspaceId}`,
						Tags: [{ TagKey: 'maskin-workspace-id', TagValue: workspaceId }],
					}),
				)
				.catch((e) => {
					throw this.mapError(e)
				})
			const keyId = created.KeyMetadata?.KeyId
			if (!keyId) throw new KmsAccessError('KMS CreateKey returned no key id')
			try {
				await this.client.send(new CreateAliasCommand({ AliasName: alias, TargetKeyId: keyId }))
			} catch (e) {
				// Lost a race with another process: the alias exists, use theirs.
				if (awsErrorName(e) !== 'AlreadyExistsException') throw this.mapError(e)
			}
		}

		await this.db
			.insert(workspaceKmsAliases)
			.values({ workspaceId, kekAlias: alias, provider: 'aws-kms' })
			.onConflictDoNothing()
		return alias
	}
}

// ── Selection ───────────────────────────────────────────────────────────────

export const KEYCHAIN_KMS_VALUES = ['aws-kms', 'local-file'] as const
export type KeychainKmsKind = (typeof KEYCHAIN_KMS_VALUES)[number]

/**
 * Parses KEYCHAIN_KMS. An unknown value throws, which is how the process fails
 * at startup instead of picking a provider by accident. Unset is local-file
 * outside production; in production it throws, because a KEK file on a
 * container disk is not a place to keep the root of trust by default.
 */
export function resolveKeychainKmsKind(
	env: Record<string, string | undefined> = process.env,
): KeychainKmsKind {
	const raw = env.KEYCHAIN_KMS?.trim()
	if (!raw) {
		if (env.NODE_ENV === 'production') {
			throw new KmsConfigError(
				`KEYCHAIN_KMS must be set in production (one of: ${KEYCHAIN_KMS_VALUES.join(', ')})`,
			)
		}
		return 'local-file'
	}
	if ((KEYCHAIN_KMS_VALUES as readonly string[]).includes(raw)) return raw as KeychainKmsKind
	throw new KmsConfigError(
		`Unknown KEYCHAIN_KMS value "${raw}" (expected one of: ${KEYCHAIN_KMS_VALUES.join(', ')})`,
	)
}

export function createKmsProvider(
	db: Database,
	env: Record<string, string | undefined> = process.env,
): KmsProvider {
	const kind = resolveKeychainKmsKind(env)
	if (kind === 'aws-kms') return new AwsKmsProvider({ db, region: env.AWS_REGION })
	return new LocalFileKmsProvider(env.KEYCHAIN_LOCAL_KEK_FILE?.trim() || DEFAULT_KEK_FILE)
}
