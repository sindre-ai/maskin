import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
	KmsConfigError,
	KmsDecryptError,
	LocalFileKmsProvider,
	createKmsProvider,
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
		expect(rows.get(WS_A)?.kekAlias).toBe(`alias/maskin-keychain-${WS_A}`)
		expect(kmsMock.commandCalls(CreateAliasCommand)[0].args[0].input).toMatchObject({
			AliasName: `alias/maskin-keychain-${WS_A}`,
			TargetKeyId: 'key-1',
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
			createKmsProvider(db, { KEYCHAIN_KMS: 'aws-kms', AWS_REGION: 'eu-central-1' }),
		).toBeInstanceOf(AwsKmsProvider)
		expect(createKmsProvider(db, { KEYCHAIN_KMS: 'local-file' })).toBeInstanceOf(
			LocalFileKmsProvider,
		)
	})

	it('fails on an unknown value', () => {
		expect(() => resolveKeychainKmsKind({ KEYCHAIN_KMS: 'none' })).toThrow(KmsConfigError)
		expect(() => createKmsProvider(db, { KEYCHAIN_KMS: 'gcp-kms' })).toThrow(/Unknown KEYCHAIN_KMS/)
	})

	it('defaults to local-file outside production, and refuses to default in production', () => {
		expect(resolveKeychainKmsKind({})).toBe('local-file')
		expect(resolveKeychainKmsKind({ NODE_ENV: 'test' })).toBe('local-file')
		expect(() => resolveKeychainKmsKind({ NODE_ENV: 'production' })).toThrow(KmsConfigError)
	})
})
