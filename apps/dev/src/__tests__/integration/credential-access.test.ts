import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	KmsAccessError,
	KmsDecryptError,
	type KmsProvider,
	LocalFileKmsProvider,
} from '@maskin/auth/kms'
import { events, type Integration, type ScopeGrant, integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const captureMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: captureMock }))

import { decrypt, encrypt, encryptEnvelope } from '../../lib/crypto'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { writeEnvelopeCredential } from '../../lib/integrations/credential-write'
import {
	CredentialNotFoundError,
	CredentialPendingError,
	CredentialUnavailableError,
	CredentialUndoneError,
	ScopeDeniedError,
} from '../../lib/integrations/errors'
import {
	clearHeaderMintAdapters,
	registerHeaderMintAdapter,
} from '../../lib/integrations/header-mint'
import {
	type CredentialReadContext,
	getCredential,
	getIntegrationCredential,
} from '../../lib/integrations/lookup'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// Obviously fake credential values.
const SECRET = 'fake-api-key-not-real-0000'

let dir: string
let kms: LocalFileKmsProvider

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'cred-access-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
beforeEach(() => {
	captureMock.mockClear()
	clearHeaderMintAdapters()
})

async function setup() {
	const createdBy = getTestActorId()
	const ws = await insertWorkspace(db, createdBy)
	const actorA = await insertActor(db)
	const actorB = await insertActor(db)
	return { ws, createdBy, actorA, actorB }
}

async function insertIntegration(
	s: Awaited<ReturnType<typeof setup>>,
	opts: {
		grants?: unknown
		status?: string
		legacy?: boolean
		source?: string
		originSessionId?: string
		provider?: string
		metadata?: Record<string, unknown>
		value?: string
	} = {},
): Promise<Integration> {
	const value = opts.value ?? SECRET
	const sealed = opts.legacy
		? { credentials: encrypt(value), dekCiphertext: null }
		: await encryptEnvelope(kms, s.ws.id, value)
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId: s.ws.id,
			provider: opts.provider ?? 'fake-provider',
			status: (opts.status ?? 'active') as 'active',
			credentials: sealed.credentials,
			dekCiphertext: sealed.dekCiphertext,
			scopeGrants: (opts.grants ?? [{ kind: 'actor', actorId: s.actorA.id }]) as ScopeGrant[],
			source: (opts.source ?? 'admin_ui') as 'admin_ui',
			originSessionId: opts.originSessionId,
			metadata: opts.metadata ?? null,
			createdBy: s.createdBy,
		})
		.returning()
	return row
}

// A chat_capture row needs a real session for its FK.
async function sessionRow(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
	const row = await insertSession(db, s.ws.id, s.actorA.id, s.createdBy)
	return row.id
}

const ctxFor = (
	actorId: string,
	extra: Partial<CredentialReadContext> = {},
): CredentialReadContext => ({
	requestingActorId: actorId,
	sessionId: randomUUID(),
	requestId: `req-${randomUUID()}`,
	...extra,
})

const logRows = (workspaceId: string) =>
	sql<Record<string, unknown>[]>`
		SELECT id::text, integration_id::text, actor_id::text, session_id::text, loop_id::text,
			outbound_target, action, source, request_id
		FROM credential_access_log WHERE workspace_id = ${workspaceId} ORDER BY id
	`

const deniedEvents = (workspaceId: string) =>
	db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'credential_scope_denied')))

describe('getCredential: scope', () => {
	it('a granted actor reads the credential and exactly one audit row appears', async () => {
		const s = await setup()
		const row = await insertIntegration(s)
		const ctx = ctxFor(s.actorA.id, { outboundTarget: 'api.example.test' })

		const cred = await getCredential(db, s.ws.id, row.id, ctx, { kms })

		expect(cred.value).toBe(SECRET)
		expect(cred.credentialSource).toBe('vault')
		const logs = await logRows(s.ws.id)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({
			integration_id: row.id,
			actor_id: s.actorA.id,
			session_id: ctx.sessionId,
			loop_id: null,
			outbound_target: 'api.example.test',
			action: 'read',
			source: 'admin_ui',
			request_id: ctx.requestId,
		})
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('an ungranted actor gets ScopeDeniedError, no audit row, one credential_scope_denied event', async () => {
		const s = await setup()
		const row = await insertIntegration(s) // granted to actor A only
		const ctx = ctxFor(s.actorB.id)

		await expect(getCredential(db, s.ws.id, row.id, ctx, { kms })).rejects.toBeInstanceOf(
			ScopeDeniedError,
		)

		expect(await logRows(s.ws.id)).toHaveLength(0)
		const denied = await deniedEvents(s.ws.id)
		expect(denied).toHaveLength(1)
		expect(denied[0]).toMatchObject({
			actorId: s.actorB.id,
			entityType: 'integration',
			entityId: row.id,
		})
		expect(denied[0].data).toMatchObject({ request_id: ctx.requestId, session_id: ctx.sessionId })
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('fails closed on an empty grant list and on grants it does not understand', async () => {
		const s = await setup()
		for (const [i, grants] of [
			[],
			[{ kind: 'galaxy' }],
			[{ kind: 'actor' }],
			[null],
			['workspace'],
		].entries()) {
			const row = await insertIntegration(s, { grants, provider: `fake-provider-${i}` })
			await expect(
				getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms }),
			).rejects.toBeInstanceOf(ScopeDeniedError)
		}
		expect(await logRows(s.ws.id)).toHaveLength(0)
	})

	it('a loop grant admits an actor driving that loop and nobody else', async () => {
		const s = await setup()
		const loopId = randomUUID()
		const row = await insertIntegration(s, { grants: [{ kind: 'loop', loopId }] })

		const ok = await getCredential(
			db,
			s.ws.id,
			row.id,
			ctxFor(s.actorB.id, { requestingLoopId: loopId }),
			{ kms },
		)
		expect(ok.value).toBe(SECRET)
		expect((await logRows(s.ws.id))[0]).toMatchObject({ loop_id: loopId })

		for (const requestingLoopId of [randomUUID(), null, undefined]) {
			await expect(
				getCredential(db, s.ws.id, row.id, ctxFor(s.actorB.id, { requestingLoopId }), { kms }),
			).rejects.toBeInstanceOf(ScopeDeniedError)
		}
	})

	it('a workspace grant admits any actor', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		for (const actor of [s.actorA, s.actorB]) {
			const cred = await getCredential(db, s.ws.id, row.id, ctxFor(actor.id), { kms })
			expect(cred.value).toBe(SECRET)
		}
		expect(await logRows(s.ws.id)).toHaveLength(2)
	})

	it('does not find a credential through another workspace', async () => {
		const s = await setup()
		const other = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		await expect(
			getCredential(db, other.ws.id, row.id, ctxFor(other.actorA.id), { kms }),
		).rejects.toBeInstanceOf(CredentialNotFoundError)
	})
})

describe('getCredential: status', () => {
	it('pending_undo is readable', async () => {
		const s = await setup()
		const row = await insertIntegration(s, {
			status: 'pending_undo',
			source: 'chat_capture',
			originSessionId: await sessionRow(s),
		})
		const cred = await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
		expect(cred.value).toBe(SECRET)
		expect((await logRows(s.ws.id))[0]).toMatchObject({ source: 'chat_capture' })
	})

	it('undone throws CredentialUndoneError and writes nothing', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { status: 'undone' })
		await expect(
			getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms }),
		).rejects.toBeInstanceOf(CredentialUndoneError)
		expect(await logRows(s.ws.id)).toHaveLength(0)
	})

	it('pending throws CredentialPendingError', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { status: 'pending' })
		await expect(
			getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms }),
		).rejects.toBeInstanceOf(CredentialPendingError)
	})

	it.each(['revoked', 'error', 'inactive', 'awaiting_secret'])(
		'%s throws CredentialUnavailableError',
		async (status) => {
			const s = await setup()
			const row = await insertIntegration(s, { status })
			await expect(
				getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms }),
			).rejects.toBeInstanceOf(CredentialUnavailableError)
		},
	)
})

describe('getCredential: audit chain', () => {
	it('one row per read, in a valid chain', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		for (let i = 0; i < 3; i++)
			await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
		expect(await logRows(s.ws.id)).toHaveLength(3)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 3 })
	})

	it('a read with no session id stores NULL and the chain still verifies', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id, { sessionId: null }), { kms })
		await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id, { sessionId: undefined }), { kms })
		await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
		const logs = await logRows(s.ws.id)
		expect(logs.map((l) => l.session_id === null)).toEqual([true, true, false])
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 3 })
	})

	it('a denied read with no session id records a null session on the event and writes no log row', async () => {
		const s = await setup()
		const row = await insertIntegration(s)
		await expect(
			getCredential(db, s.ws.id, row.id, ctxFor(s.actorB.id, { sessionId: null }), { kms }),
		).rejects.toBeInstanceOf(ScopeDeniedError)
		expect(await logRows(s.ws.id)).toHaveLength(0)
		const [event] = await deniedEvents(s.ws.id)
		expect((event.data as { session_id: unknown }).session_id).toBeNull()
	})

	it('concurrent reads get distinct sequential ids and a consistent chain', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		await Promise.all(
			Array.from({ length: 15 }, () =>
				getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms }),
			),
		)
		const logs = await logRows(s.ws.id)
		expect(new Set(logs.map((l) => l.id)).size).toBe(15)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 15 })
	})

	it('a read whose audit insert fails returns no credential', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		// actor_id has a foreign key: an actor that does not exist cannot be logged.
		await expect(
			getCredential(db, s.ws.id, row.id, ctxFor(randomUUID()), { kms }),
		).rejects.toMatchObject({ cause: { code: '23503' } }) // foreign_key_violation
		expect(await logRows(s.ws.id)).toHaveLength(0)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('leaves the session at the constrained role only for the insert', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
		const [{ current_user }] = await sql<{ current_user: string }[]>`SELECT current_user`
		expect(current_user).not.toBe('maskin_keychain_app')
	})
})

describe('getCredential: encryption', () => {
	it('decrypts a legacy row (NULL dek_ciphertext) without touching KMS', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { legacy: true, grants: [{ kind: 'workspace' }] })
		const neverCalled: KmsProvider = {
			encrypt: vi.fn(async () => {
				throw new Error('KMS must not be used')
			}),
			decrypt: vi.fn(async () => {
				throw new Error('KMS must not be used')
			}),
		}
		const cred = await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms: neverCalled })
		expect(cred.value).toBe(SECRET)
		expect(neverCalled.decrypt).not.toHaveBeenCalled()
	})

	it('a legacy row upgrades to envelope on its next write, then no longer needs the legacy key', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { legacy: true, grants: [{ kind: 'workspace' }] })
		expect(row.dekCiphertext).toBeNull()

		await writeEnvelopeCredential(db, kms, {
			workspaceId: s.ws.id,
			integrationId: row.id,
			plaintext: 'fake-refreshed-token',
		})
		const [after] = await db.select().from(integrations).where(eq(integrations.id, row.id))
		expect(after.dekCiphertext).toBeTruthy()
		expect(() => decrypt(after.credentials)).toThrow() // no longer a legacy ciphertext

		const original = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = 'c'.repeat(64)
		try {
			const cred = await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
			expect(cred.value).toBe('fake-refreshed-token')
		} finally {
			process.env.INTEGRATION_ENCRYPTION_KEY = original
		}
	})

	it('a KMS access failure throws KmsAccessError, never a null, and logs nothing', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		const denied: KmsProvider = {
			encrypt: kms.encrypt.bind(kms),
			decrypt: async () => {
				throw new KmsAccessError()
			},
		}
		await expect(
			getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms: denied }),
		).rejects.toBeInstanceOf(KmsAccessError)
		expect(await logRows(s.ws.id)).toHaveLength(0)
		expect(captureMock).not.toHaveBeenCalled()
	})

	it('a corrupted dek_ciphertext throws KmsDecryptError and logs nothing', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		const blob = Buffer.from(row.dekCiphertext as string, 'base64')
		blob[blob.length - 1] ^= 0x01
		await db
			.update(integrations)
			.set({ dekCiphertext: blob.toString('base64') })
			.where(eq(integrations.id, row.id))
		await expect(
			getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms }),
		).rejects.toBeInstanceOf(KmsDecryptError)
		expect(await logRows(s.ws.id)).toHaveLength(0)
	})
})

describe('getCredential: analytics', () => {
	it('fires keychain_credential_accessed once per successful read, without the secret', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		await getCredential(
			db,
			s.ws.id,
			row.id,
			ctxFor(s.actorA.id, { outboundTarget: 'api.example.test' }),
			{ kms },
		)
		expect(captureMock).toHaveBeenCalledTimes(1)
		const [event, distinctId, props] = captureMock.mock.calls[0] as unknown as [
			string,
			string,
			Record<string, unknown>,
		]
		expect(event).toBe('keychain_credential_accessed')
		expect(distinctId).toBe(s.actorA.id)
		expect(props).toMatchObject({
			workspace_id: s.ws.id,
			integration_id: row.id,
			provider: 'fake-provider',
		})
		expect(JSON.stringify(props)).not.toContain(SECRET)
	})
})

describe('DecryptedCredential', () => {
	it('synthesises Bearer headers in vault mode and unwraps an accessToken blob', async () => {
		const s = await setup()
		const bare = await insertIntegration(s, {
			grants: [{ kind: 'workspace' }],
			provider: 'bare-secret',
		})
		const blob = await insertIntegration(s, {
			provider: 'oauth-blob',
			grants: [{ kind: 'workspace' }],
			value: JSON.stringify({ accessToken: 'fake-oauth-token', refreshToken: 'fake-refresh' }),
		})
		const hctx = { outboundTarget: 'https://api.example.test', requestId: 'r' }
		const a = await getCredential(db, s.ws.id, bare.id, ctxFor(s.actorA.id), { kms })
		const b = await getCredential(db, s.ws.id, blob.id, ctxFor(s.actorA.id), { kms })
		expect(await a.getHeaders(hctx)).toEqual({ Authorization: `Bearer ${SECRET}` })
		expect(await b.getHeaders(hctx)).toEqual({ Authorization: 'Bearer fake-oauth-token' })
	})

	it('hands header minting to a registered adapter when metadata.adapterKind names one', async () => {
		const s = await setup()
		const mint = vi.fn(async () => ({ Authorization: 'Bearer minted-by-adapter' }))
		registerHeaderMintAdapter({ kind: 'external:fake-vault', mint })
		const row = await insertIntegration(s, {
			grants: [{ kind: 'workspace' }],
			metadata: { adapterKind: 'external:fake-vault' },
		})
		const cred = await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
		expect(cred.credentialSource).toBe('external:fake-vault')
		const hctx = { outboundTarget: 'https://api.example.test', requestId: 'r' }
		expect(await cred.getHeaders(hctx)).toEqual({ Authorization: 'Bearer minted-by-adapter' })
		expect(mint).toHaveBeenCalledWith(row.id, hctx)
	})

	it('does not put the secret into JSON.stringify output', async () => {
		const s = await setup()
		const row = await insertIntegration(s, { grants: [{ kind: 'workspace' }] })
		const cred = await getCredential(db, s.ws.id, row.id, ctxFor(s.actorA.id), { kms })
		expect(JSON.stringify(cred)).not.toContain(SECRET)
	})
})

describe('getIntegrationCredential with a read context', () => {
	beforeEach(() => setKmsProviderForTests(kms))
	afterAll(() => setKmsProviderForTests(undefined))

	it('resolves the row, enforces scope, writes the audit row and returns a DecryptedCredential', async () => {
		const s = await setup()
		const row = await insertIntegration(s)
		const ctx = ctxFor(s.actorA.id)

		const cred = await getIntegrationCredential(db, s.ws.id, 'fake-provider', null, { ctx })

		expect(cred?.id).toBe(row.id)
		expect(cred?.value).toBe(SECRET)
		expect(await logRows(s.ws.id)).toHaveLength(1)
	})

	it('denies an ungranted actor the same way getCredential does', async () => {
		const s = await setup()
		await insertIntegration(s)
		await expect(
			getIntegrationCredential(db, s.ws.id, 'fake-provider', null, { ctx: ctxFor(s.actorB.id) }),
		).rejects.toBeInstanceOf(ScopeDeniedError)
		expect(await logRows(s.ws.id)).toHaveLength(0)
		expect(await deniedEvents(s.ws.id)).toHaveLength(1)
	})

	it('returns null when no row matches', async () => {
		const s = await setup()
		expect(
			await getIntegrationCredential(db, s.ws.id, 'no-such-provider', null, {
				ctx: ctxFor(s.actorA.id),
			}),
		).toBeNull()
	})

	it('sees a pending_undo row only with a read context', async () => {
		const s = await setup()
		await insertIntegration(s, {
			status: 'pending_undo',
			source: 'chat_capture',
			originSessionId: await sessionRow(s),
		})
		expect(await getIntegrationCredential(db, s.ws.id, 'fake-provider', null)).toBeNull()
		const cred = await getIntegrationCredential(db, s.ws.id, 'fake-provider', null, {
			ctx: ctxFor(s.actorA.id),
		})
		expect(cred?.value).toBe(SECRET)
	})

	it('without a read context it still returns the raw row and writes no audit row', async () => {
		const s = await setup()
		const row = await insertIntegration(s)
		const found = await getIntegrationCredential(db, s.ws.id, 'fake-provider', null)
		expect(found?.id).toBe(row.id)
		expect(found?.credentials).toBe(row.credentials)
		expect(await logRows(s.ws.id)).toHaveLength(0)
	})
})
