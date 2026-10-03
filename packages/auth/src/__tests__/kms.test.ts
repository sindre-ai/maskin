import { randomBytes } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	CreateAliasCommand,
	CreateKeyCommand,
	DecryptCommand,
	DescribeKeyCommand,
	EncryptCommand,
	KMSClient,
} from '@aws-sdk/client-kms'
import type { Database } from '@maskin/db'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	AwsKmsProvider,
	KmsAccessError,
	KmsBackupNotConfirmedError,
	KmsConfigError,
	KmsDecryptError,
	KmsKekMissingError,
	LocalFileKmsProvider,
	createKmsProvider,
	resolveKeychainEnv,
	resolveKeychainKmsKind,
} from '../kms'

const WS_A = '11111111-1111-4111-8111-111111111111'
const WS_B = '22222222-2222-4222-8222-222222222222'

// Not a real key: obviously fake DEK bytes.
const fakeDek = () => Buffer.alloc(32, 7)

describe('LocalFileKmsProvider', () => {
	let dir: string
	let kekPath: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'keychain-kek-'))
		kekPath = join(dir, 'nested', 'keychain-kek')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('round-trips a DEK', async () => {
		const kms = new LocalFileKmsProvider(kekPath)
		const dek = randomBytes(32)
		const wrapped = await kms.encrypt(WS_A, dek)
		expect(wrapped).not.toContain(dek.toString('base64'))
		expect((await kms.decrypt(WS_A, wrapped)).equals(dek)).toBe(true)
	})

	it('auto-generates the key file with 600 permissions on first use', async () => {
		await new LocalFileKmsProvider(kekPath).encrypt(WS_A, fakeDek())
		expect(statSync(kekPath).mode & 0o777).toBe(0o600)
	})

	it('survives a restart: a new provider reads the same file', async () => {
		const wrapped = await new LocalFileKmsProvider(kekPath).encrypt(WS_A, fakeDek())
		const again = await new LocalFileKmsProvider(kekPath).decrypt(WS_A, wrapped)
		expect(again.equals(fakeDek())).toBe(true)
	})

	it('concurrent first writes do not corrupt the key file', async () => {
		const providers = Array.from({ length: 12 }, () => new LocalFileKmsProvider(kekPath))
		const wrapped = await Promise.all(providers.map((p) => p.encrypt(WS_A, fakeDek())))
		// Every wrapped key must open under every other instance: they all agreed on one KEK.
		const fresh = new LocalFileKmsProvider(kekPath)
		for (const w of wrapped) expect((await fresh.decrypt(WS_A, w)).equals(fakeDek())).toBe(true)
	})

	it('does not unwrap a key wrapped for another workspace', async () => {
		const kms = new LocalFileKmsProvider(kekPath)
		const wrapped = await kms.encrypt(WS_A, fakeDek())
		await expect(kms.decrypt(WS_B, wrapped)).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('throws KmsDecryptError when one byte of the wrapped key is flipped', async () => {
		const kms = new LocalFileKmsProvider(kekPath)
		const blob = Buffer.from(await kms.encrypt(WS_A, fakeDek()), 'base64')
		blob[blob.length - 1] ^= 0x01
		await expect(kms.decrypt(WS_A, blob.toString('base64'))).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('refuses to create a new KEK when wrapped credentials already exist', async () => {
		const kms = new LocalFileKmsProvider(kekPath, async () => true)
		await expect(kms.encrypt(WS_A, fakeDek())).rejects.toBeInstanceOf(KmsKekMissingError)
		await expect(kms.prepare()).rejects.toBeInstanceOf(KmsKekMissingError)
		expect(existsSync(kekPath)).toBe(false)
	})

	it('still reads an existing KEK when wrapped credentials exist', async () => {
		const wrapped = await new LocalFileKmsProvider(kekPath).encrypt(WS_A, fakeDek())
		const kms = new LocalFileKmsProvider(kekPath, async () => true)
		expect((await kms.decrypt(WS_A, wrapped)).equals(fakeDek())).toBe(true)
	})

	it('creates the KEK when no credential is wrapped yet, and recovers after a refusal once the file is back', async () => {
		let wrapped = true
		const kms = new LocalFileKmsProvider(kekPath, async () => wrapped)
		await expect(kms.prepare()).rejects.toBeInstanceOf(KmsKekMissingError)
		wrapped = false
		await expect(kms.prepare()).resolves.toMatchObject({ existed: false })
		expect(statSync(kekPath).mode & 0o777).toBe(0o600)
	})

	it('prepare reports whether the file existed, and a stable 8-hex fingerprint that is not the key', async () => {
		const first = await new LocalFileKmsProvider(kekPath).prepare()
		const second = await new LocalFileKmsProvider(kekPath).prepare()
		expect(first.existed).toBe(false)
		expect(second.existed).toBe(true)
		expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/)
		expect(second.fingerprint).toBe(first.fingerprint)
		expect(readFileSync(kekPath, 'utf8')).not.toContain(first.fingerprint)
	})

	it('pins the fingerprint formula: first 8 hex of sha256 over the decoded key bytes, then the fixed label', async () => {
		// The README tells a human how to check an off-volume KEK copy against the boot log.
		// Changing the formula would break that check, so this value must not change.
		mkdirSync(dirname(kekPath), { recursive: true })
		writeFileSync(kekPath, '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n', {
			mode: 0o600,
		})
		const { fingerprint } = await new LocalFileKmsProvider(kekPath).prepare()
		expect(fingerprint).toBe('2b387596')
	})

	it('rejects a key file that is not 32 bytes of hex', async () => {
		writeFileSync(join(dir, 'bad'), 'abcd')
		await expect(
			new LocalFileKmsProvider(join(dir, 'bad')).encrypt(WS_A, fakeDek()),
		).rejects.toBeInstanceOf(KmsConfigError)
	})
})

/** Just enough of the drizzle query builder for AwsKmsProvider's two queries. */
function fakeAliasDb() {
	const rows = new Map<string, { kekAlias: string; provider: string }>()
	let inserts = 0
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => {
						const [row] = [...rows.values()]
						return row ? [{ kekAlias: row.kekAlias }] : []
					},
				}),
			}),
		}),
		insert: () => ({
			values: (v: { workspaceId: string; kekAlias: string; provider: string }) => ({
				onConflictDoNothing: async () => {
					inserts++
					if (!rows.has(v.workspaceId)) rows.set(v.workspaceId, v)
				},
			}),
		}),
	}
	return { db: db as unknown as Database, rows, inserts: () => inserts }
}

class AwsError extends Error {
	constructor(name: string) {
		super(name)
		this.name = name
	}
}

describe('AwsKmsProvider (mocked KMS client)', () => {
	const kmsMock = mockClient(KMSClient)
	beforeEach(() => kmsMock.reset())

	function provider() {
		const store = fakeAliasDb()
		const kms = new AwsKmsProvider({
			db: store.db,
			client: new KMSClient({ region: 'eu-central-1' }),
			environment: 'staging',
		})
		return { kms, ...store }
	}

	it('provisions the workspace alias on first write, then round-trips', async () => {
		kmsMock.on(DescribeKeyCommand).rejects(new AwsError('NotFoundException'))
		kmsMock.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1', Arn: 'arn:fake' } })
		kmsMock.on(CreateAliasCommand).resolves({})
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('wrapped-by-kms') })
		kmsMock.on(DecryptCommand).resolves({ Plaintext: fakeDek() })

		const { kms, rows } = provider()
		const wrapped = await kms.encrypt(WS_A, fakeDek())
		expect(Buffer.from(wrapped, 'base64').toString()).toBe('wrapped-by-kms')
		expect(rows.get(WS_A)?.kekAlias).toBe(`alias/maskin-keychain-staging-${WS_A}`)
		expect(kmsMock.commandCalls(CreateAliasCommand)[0].args[0].input).toMatchObject({
			AliasName: `alias/maskin-keychain-staging-${WS_A}`,
			TargetKeyId: 'key-1',
		})

		// The key is tagged with the environment value the IAM boundary checks.
		expect(kmsMock.commandCalls(CreateKeyCommand)[0].args[0].input.Tags).toContainEqual({
			TagKey: 'maskin-keychain',
			TagValue: 'staging',
		})

		expect((await kms.decrypt(WS_A, wrapped)).equals(fakeDek())).toBe(true)
		// The workspace id is bound as encryption context on both calls.
		expect(kmsMock.commandCalls(EncryptCommand)[0].args[0].input.EncryptionContext).toEqual({
			workspace_id: WS_A,
		})
		expect(kmsMock.commandCalls(DecryptCommand)[0].args[0].input.EncryptionContext).toEqual({
			workspace_id: WS_A,
		})
	})

	it('does not provision twice: second write reuses the stored alias', async () => {
		kmsMock.on(DescribeKeyCommand).rejects(new AwsError('NotFoundException'))
		kmsMock.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(CreateAliasCommand).resolves({})
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('x') })

		const { kms } = provider()
		await kms.encrypt(WS_A, fakeDek())
		await kms.encrypt(WS_A, fakeDek())
		expect(kmsMock.commandCalls(CreateKeyCommand)).toHaveLength(1)
	})

	it('concurrent first writes provision once', async () => {
		kmsMock.on(DescribeKeyCommand).rejects(new AwsError('NotFoundException'))
		kmsMock.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(CreateAliasCommand).resolves({})
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('x') })

		const { kms } = provider()
		await Promise.all([1, 2, 3, 4, 5].map(() => kms.encrypt(WS_A, fakeDek())))
		expect(kmsMock.commandCalls(CreateKeyCommand)).toHaveLength(1)
		expect(kmsMock.commandCalls(CreateAliasCommand)).toHaveLength(1)
	})

	it('adopts an alias that already exists in KMS (retry after a lost table write)', async () => {
		kmsMock.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('x') })

		const { kms, rows } = provider()
		await kms.encrypt(WS_A, fakeDek())
		expect(kmsMock.commandCalls(CreateKeyCommand)).toHaveLength(0)
		expect(rows.has(WS_A)).toBe(true)
	})

	it('adopts the winner when CreateAlias loses a race', async () => {
		kmsMock.on(DescribeKeyCommand).rejects(new AwsError('NotFoundException'))
		kmsMock.on(CreateKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(CreateAliasCommand).rejects(new AwsError('AlreadyExistsException'))
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('x') })

		const { kms, rows } = provider()
		await expect(kms.encrypt(WS_A, fakeDek())).resolves.toBeTypeOf('string')
		expect(rows.has(WS_A)).toBe(true)
	})

	it('surfaces AccessDenied on Encrypt as KmsAccessError, not a silent null', async () => {
		kmsMock.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(EncryptCommand).rejects(new AwsError('AccessDeniedException'))
		const { kms } = provider()
		await expect(kms.encrypt(WS_A, fakeDek())).rejects.toBeInstanceOf(KmsAccessError)
	})

	it('surfaces AccessDenied on Decrypt as KmsAccessError', async () => {
		kmsMock.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('x') })
		kmsMock.on(DecryptCommand).rejects(new AwsError('AccessDeniedException'))
		const { kms } = provider()
		const wrapped = await kms.encrypt(WS_A, fakeDek())
		await expect(kms.decrypt(WS_A, wrapped)).rejects.toBeInstanceOf(KmsAccessError)
	})

	it('surfaces AccessDenied while provisioning as KmsAccessError', async () => {
		kmsMock.on(DescribeKeyCommand).rejects(new AwsError('NotFoundException'))
		kmsMock.on(CreateKeyCommand).rejects(new AwsError('AccessDeniedException'))
		const { kms } = provider()
		await expect(kms.encrypt(WS_A, fakeDek())).rejects.toBeInstanceOf(KmsAccessError)
	})

	it('maps a corrupted ciphertext to KmsDecryptError', async () => {
		kmsMock.on(DescribeKeyCommand).resolves({ KeyMetadata: { KeyId: 'key-1' } })
		kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: Buffer.from('x') })
		kmsMock.on(DecryptCommand).rejects(new AwsError('InvalidCiphertextException'))
		const { kms } = provider()
		const wrapped = await kms.encrypt(WS_A, fakeDek())
		await expect(kms.decrypt(WS_A, wrapped)).rejects.toBeInstanceOf(KmsDecryptError)
	})

	it('decrypt for a workspace with no alias is a KmsDecryptError, not a KMS call', async () => {
		const { kms } = provider()
		await expect(kms.decrypt(WS_B, 'AAAA')).rejects.toBeInstanceOf(KmsDecryptError)
		expect(kmsMock.commandCalls(DecryptCommand)).toHaveLength(0)
	})
})

describe('KEYCHAIN_KMS selection', () => {
	const db = {} as Database

	it('picks aws-kms and local-file', () => {
		expect(resolveKeychainKmsKind({ KEYCHAIN_KMS: 'aws-kms' })).toBe('aws-kms')
		expect(resolveKeychainKmsKind({ KEYCHAIN_KMS: 'local-file' })).toBe('local-file')
		expect(
			createKmsProvider(db, {
				KEYCHAIN_KMS: 'aws-kms',
				KEYCHAIN_ENV: 'staging',
				AWS_REGION: 'eu-central-1',
			}),
		).toBeInstanceOf(AwsKmsProvider)
		expect(createKmsProvider(db, { KEYCHAIN_KMS: 'local-file' })).toBeInstanceOf(
			LocalFileKmsProvider,
		)
	})

	it('fails on an unknown value', () => {
		expect(() => resolveKeychainKmsKind({ KEYCHAIN_KMS: 'none' })).toThrow(KmsConfigError)
		expect(() => createKmsProvider(db, { KEYCHAIN_KMS: 'gcp-kms' })).toThrow(/Unknown KEYCHAIN_KMS/)
	})

	it('aws-kms needs KEYCHAIN_ENV set to staging or production', () => {
		expect(resolveKeychainEnv({ KEYCHAIN_ENV: 'production' })).toBe('production')
		expect(() => createKmsProvider(db, { KEYCHAIN_KMS: 'aws-kms' })).toThrow(
			/KEYCHAIN_ENV must be set/,
		)
		expect(() => createKmsProvider(db, { KEYCHAIN_KMS: 'aws-kms', KEYCHAIN_ENV: 'prod' })).toThrow(
			/Unknown KEYCHAIN_ENV/,
		)
		// local-file never reads it.
		expect(createKmsProvider(db, { KEYCHAIN_KMS: 'local-file' })).toBeInstanceOf(
			LocalFileKmsProvider,
		)
	})

	it('defaults to local-file outside production, and refuses to default in production', () => {
		expect(resolveKeychainKmsKind({})).toBe('local-file')
		expect(resolveKeychainKmsKind({ NODE_ENV: 'test' })).toBe('local-file')
		expect(() => resolveKeychainKmsKind({ NODE_ENV: 'production' })).toThrow(KmsConfigError)
	})
})

describe('local-file backup-confirmed gate', () => {
	let dir: string
	let kekPath: string
	// No integration row is wrapped yet, so a missing KEK file may be created.
	const db = {
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
	} as unknown as Database
	const prod = (confirmed?: string) => ({
		KEYCHAIN_KMS: 'local-file',
		NODE_ENV: 'production',
		KEYCHAIN_LOCAL_KEK_FILE: kekPath,
		...(confirmed === undefined ? {} : { KEYCHAIN_KEK_BACKUP_CONFIRMED: confirmed }),
	})

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'keychain-kek-gate-'))
		kekPath = join(dir, 'kek')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('refuses to wrap in production when the marker is unset, and writes no KEK file', async () => {
		const kms = createKmsProvider(db, prod())
		const err = await kms.encrypt(WS_A, fakeDek()).catch((e) => e)
		expect(err).toBeInstanceOf(KmsBackupNotConfirmedError)
		expect(err.message).toMatch(/^KEK_BACKUP_UNCONFIRMED:/)
		expect(err.code).toBe('KEK_BACKUP_UNCONFIRMED')
		expect(existsSync(kekPath)).toBe(false)
	})

	it.each(['false', '', '1', 'yes', 'TRUE'])('treats %j as not confirmed', async (value) => {
		const kms = createKmsProvider(db, prod(value))
		await expect(kms.encrypt(WS_A, fakeDek())).rejects.toBeInstanceOf(KmsBackupNotConfirmedError)
	})

	it('wraps and unwraps in production once the marker is true', async () => {
		const kms = createKmsProvider(db, prod('true'))
		const wrapped = await kms.encrypt(WS_A, fakeDek())
		expect((await kms.decrypt(WS_A, wrapped)).equals(fakeDek())).toBe(true)
	})

	it('does not gate decrypt or the boot-time prepare', async () => {
		const wrapped = await createKmsProvider(db, prod('true')).encrypt(WS_A, fakeDek())
		const closed = createKmsProvider(db, prod()) as LocalFileKmsProvider
		expect((await closed.decrypt(WS_A, wrapped)).equals(fakeDek())).toBe(true)
		await expect(closed.prepare()).resolves.toMatchObject({ existed: true })
	})

	it('is not applied outside production', async () => {
		const kms = createKmsProvider(db, {
			KEYCHAIN_KMS: 'local-file',
			KEYCHAIN_LOCAL_KEK_FILE: kekPath,
		})
		await expect(kms.encrypt(WS_A, fakeDek())).resolves.toEqual(expect.any(String))
	})
})
