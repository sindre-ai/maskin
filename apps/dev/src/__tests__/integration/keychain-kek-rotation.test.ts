import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AwsKmsProvider, type AwsKmsProviderOptions, LocalFileKmsProvider } from '@maskin/auth/kms'
import { workspaceKmsAliases } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import { rotateWorkspaceKek } from '../../lib/integrations/rotate-kek'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql as pg } from './global-setup'

class AwsError extends Error {
	constructor(name: string) {
		super(name)
		this.name = name
	}
}

/** A stand-in for KMS: aliases that exist, a wrap that echoes, and a call log. */
function fakeKms(opts: { deniedEncrypts?: number } = {}) {
	const aliases = new Set<string>()
	const sent: string[] = []
	let denied = opts.deniedEncrypts ?? 0
	const client = {
		async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
			const name = command.constructor.name
			sent.push(name)
			switch (name) {
				case 'DescribeKeyCommand':
					if (!aliases.has(command.input.KeyId as string)) throw new AwsError('NotFoundException')
					return { KeyMetadata: { KeyId: 'key-existing' } }
				case 'CreateKeyCommand':
					return { KeyMetadata: { KeyId: 'key-new' } }
				case 'CreateAliasCommand':
					aliases.add(command.input.AliasName as string)
					return {}
				case 'EncryptCommand':
					if (denied > 0) {
						denied--
						throw new AwsError('AccessDeniedException')
					}
					return { CiphertextBlob: command.input.Plaintext }
				case 'DecryptCommand':
					return { Plaintext: command.input.CiphertextBlob }
				default:
					throw new Error(`unexpected KMS command ${name}`)
			}
		},
	}
	return { client: client as unknown as AwsKmsProviderOptions['client'], sent, aliases }
}

const baseAlias = (workspaceId: string) => `alias/maskin-keychain-staging-${workspaceId}`
const noSleep = async () => {}

async function aliasOf(workspaceId: string) {
	const [row] = await db
		.select({ kekAlias: workspaceKmsAliases.kekAlias })
		.from(workspaceKmsAliases)
		.where(eq(workspaceKmsAliases.workspaceId, workspaceId))
	return row?.kekAlias
}

async function workspaceWithAlias(alias?: string) {
	const ws = await insertWorkspace(db, getTestActorId())
	await db
		.insert(workspaceKmsAliases)
		.values({ workspaceId: ws.id, kekAlias: alias ?? baseAlias(ws.id), provider: 'aws-kms' })
	return ws
}

beforeEach(() => captureMock.mockClear())

describe('rotateWorkspaceKek', () => {
	it('creates the next key, switches kek_alias last, and reports it', async () => {
		const ws = await workspaceWithAlias()
		const fake = fakeKms()
		const kms = new AwsKmsProvider({ db, client: fake.client, environment: 'staging' })

		const result = await rotateWorkspaceKek(db, kms, ws.id, { sleep: noSleep })

		expect(result).toEqual({
			status: 'rotated',
			previousAlias: baseAlias(ws.id),
			alias: `${baseAlias(ws.id)}-2`,
		})
		expect(await aliasOf(ws.id)).toBe(`${baseAlias(ws.id)}-2`)
		expect(fake.aliases.has(`${baseAlias(ws.id)}-2`)).toBe(true)
		// The old alias is never moved, and nothing is scheduled for deletion.
		expect(fake.sent).not.toContain('UpdateAliasCommand')
		expect(fake.sent).not.toContain('ScheduleKeyDeletionCommand')
		expect(captureMock).toHaveBeenCalledWith(
			'keychain_kek_rotated',
			expect.any(String),
			expect.objectContaining({ workspace_id: ws.id, to_alias: `${baseAlias(ws.id)}-2` }),
		)
	})

	it('rotates again from the rotated alias: -2 becomes -3', async () => {
		const ws = await workspaceWithAlias()
		const fake = fakeKms()
		const kms = new AwsKmsProvider({ db, client: fake.client, environment: 'staging' })

		await rotateWorkspaceKek(db, kms, ws.id, { sleep: noSleep })
		await rotateWorkspaceKek(db, kms, ws.id, { sleep: noSleep })

		expect(await aliasOf(ws.id)).toBe(`${baseAlias(ws.id)}-3`)
	})

	it('a failed probe leaves kek_alias on the old key, and the lock is released for the next run', async () => {
		const ws = await workspaceWithAlias()
		const fake = fakeKms({ deniedEncrypts: 1000 })
		const kms = new AwsKmsProvider({ db, client: fake.client, environment: 'staging' })

		const failed = await rotateWorkspaceKek(db, kms, ws.id, { probeTimeoutMs: 0, sleep: noSleep })

		expect(failed.status).toBe('failed')
		expect(await aliasOf(ws.id)).toBe(baseAlias(ws.id))
		expect(captureMock).toHaveBeenCalledWith(
			'keychain_kek_rotation_failed',
			expect.any(String),
			expect.objectContaining({ workspace_id: ws.id }),
		)

		// Next run: the alias made by the failed one is reused, no second key.
		const creates = fake.sent.filter((n) => n === 'CreateKeyCommand').length
		const retry = fakeKms()
		retry.aliases.add(`${baseAlias(ws.id)}-2`)
		const kms2 = new AwsKmsProvider({ db, client: retry.client, environment: 'staging' })
		const again = await rotateWorkspaceKek(db, kms2, ws.id, { sleep: noSleep })
		expect(again.status).toBe('rotated')
		expect(retry.sent).not.toContain('CreateKeyCommand')
		expect(creates).toBe(1)
		expect(await aliasOf(ws.id)).toBe(`${baseAlias(ws.id)}-2`)
	})

	it('retries AccessDenied on the probe and then switches', async () => {
		const ws = await workspaceWithAlias()
		const fake = fakeKms({ deniedEncrypts: 2 })
		const kms = new AwsKmsProvider({ db, client: fake.client, environment: 'staging' })

		const result = await rotateWorkspaceKek(db, kms, ws.id, { sleep: noSleep })

		expect(result.status).toBe('rotated')
		expect(await aliasOf(ws.id)).toBe(`${baseAlias(ws.id)}-2`)
	})

	it('the loser of the lock skips without creating a key', async () => {
		const ws = await workspaceWithAlias()
		const fake = fakeKms()
		const kms = new AwsKmsProvider({ db, client: fake.client, environment: 'staging' })
		const holder = await pg.reserve()
		try {
			await holder`SELECT pg_advisory_lock(hashtextextended(${`keychain-kek-rotation:${ws.id}`}, 0))`

			const result = await rotateWorkspaceKek(db, kms, ws.id, { sleep: noSleep })

			expect(result).toEqual({ status: 'skipped', reason: 'lock_held' })
			expect(fake.sent).toHaveLength(0)
			expect(await aliasOf(ws.id)).toBe(baseAlias(ws.id))
		} finally {
			await holder`SELECT pg_advisory_unlock(hashtextextended(${`keychain-kek-rotation:${ws.id}`}, 0))`
			holder.release()
		}
	})

	it('skips a workspace with no alias row and a provider that is not aws-kms', async () => {
		const noAlias = await insertWorkspace(db, getTestActorId())
		const fake = fakeKms()
		const aws = new AwsKmsProvider({ db, client: fake.client, environment: 'staging' })
		expect(await rotateWorkspaceKek(db, aws, noAlias.id)).toEqual({
			status: 'skipped',
			reason: 'no_alias',
		})
		expect(fake.sent).toHaveLength(0)

		const dir = mkdtempSync(join(tmpdir(), 'kek-rotation-local-'))
		try {
			const local = new LocalFileKmsProvider(join(dir, 'kek'))
			const ws = await workspaceWithAlias()
			expect(await rotateWorkspaceKek(db, local, ws.id)).toEqual({
				status: 'skipped',
				reason: 'not_aws_kms',
			})
			expect(await aliasOf(ws.id)).toBe(baseAlias(ws.id))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
