import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	type ScopeGrant,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Meet's token refresh is TokenManager's job and out of scope here: stub it so no
// test calls Google. The read this file checks is the Keychain read before it.
vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = vi.fn(async () => 'fake-access-token-not-real')
	},
}))

import { encrypt } from '../../lib/crypto'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { writeEnvelopeCredential } from '../../lib/integrations/credential-write'
import { CredentialNotFoundError, ScopeDeniedError } from '../../lib/integrations/errors'
import { getCredential } from '../../lib/integrations/lookup'
import { resolveHostToken } from '../../lib/integrations/providers/google-meet/read-operations'
import { getGoogleMeetAccessToken } from '../../lib/integrations/providers/google-meet/token'
import {
	__setLinkedInClientForTests,
	sendLinkedInMessage,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { readContextFor } from '../../lib/integrations/read-context'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * The linkedin-unipile and google-meet readers go through getCredential: every
 * successful read writes one hash-chained credential_access_log row, a denied
 * read writes none, and a credential never crosses a workspace.
 *
 * Rows are seeded with the workspace grant migration 0088 gives a connected row.
 * Values are obviously fake.
 */

let kmsDir: string
let kms: LocalFileKmsProvider

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	process.env.UNIPILE_BASE_URL = 'https://unipile.test.invalid'
	process.env.UNIPILE_API_KEY = 'ignored-by-test-stub'
	kmsDir = mkdtempSync(join(tmpdir(), 'readers-kek-'))
	kms = new LocalFileKmsProvider(join(kmsDir, 'kek'))
	setKmsProviderForTests(kms)
})

afterAll(() => {
	__setLinkedInClientForTests(null)
	setKmsProviderForTests(undefined)
	rmSync(kmsDir, { recursive: true, force: true })
})

beforeEach(() => {
	__setLinkedInClientForTests(null)
})

const WORKSPACE_GRANT: ScopeGrant[] = [{ kind: 'workspace' }]

async function setup() {
	const owner = getTestActorId()
	const ws = await insertWorkspace(db, owner)
	const agent = await insertActor(db)
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	return { owner, ws, agent }
}

async function seedLinkedIn(
	workspaceId: string,
	actorId: string,
	opts: { grants?: ScopeGrant[]; accountId?: string } = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			// A legacy row: no dek_ciphertext, sealed under INTEGRATION_ENCRYPTION_KEY.
			credentials: encrypt(
				JSON.stringify({ account_id: opts.accountId ?? 'acc-fake', account_status: 'OK' }),
			),
			scopeGrants: opts.grants ?? WORKSPACE_GRANT,
			actorId,
			createdBy: actorId,
		})
		.returning()
	return row
}

async function seedMeet(
	workspaceId: string,
	createdBy: string,
	grants: ScopeGrant[] = WORKSPACE_GRANT,
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-meet',
			status: INTEGRATION_STATUS_ACTIVE,
			credentials: encrypt(JSON.stringify({ accessToken: 'fake-token-not-real' })),
			scopeGrants: grants,
			createdBy,
		})
		.returning()
	return row
}

function recordingClient(): LinkedInClient & { sendCalls: Array<{ account_id: string }> } {
	const sendCalls: Array<{ account_id: string }> = []
	const client = {
		sendMessage: async (payload: { account_id: string }) => {
			sendCalls.push({ account_id: payload.account_id })
			return {
				status: 200,
				body: { object: 'ChatStarted', message_id: 'stub-message', chat_id: 'stub-chat' },
				headers: {},
			}
		},
	} as unknown as LinkedInClient
	return Object.assign(client, { sendCalls })
}

const send = (ctx: Parameters<typeof sendLinkedInMessage>[0], key: string) =>
	sendLinkedInMessage(ctx, {
		recipient_urn: 'urn:li:person:target',
		body: 'x',
		idempotency_key: key,
	})

const logRows = (workspaceId: string) =>
	sql<Record<string, unknown>[]>`
		SELECT integration_id::text, actor_id::text, session_id::text, outbound_target, action, source
		FROM credential_access_log WHERE workspace_id = ${workspaceId} ORDER BY id
	`

const deniedEvents = (workspaceId: string) =>
	db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.action, 'credential_scope_denied')))

describe('linkedin-unipile reads through getCredential', () => {
	it('a granted read of a legacy row sends and writes exactly one audit row', async () => {
		const s = await setup()
		const row = await seedLinkedIn(s.ws.id, s.owner, { accountId: 'acc-owner' })
		expect(row.dekCiphertext).toBeNull()
		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		await send({ db, actorId: s.owner, workspaceId: s.ws.id }, 'k-granted')

		expect(client.sendCalls).toEqual([{ account_id: 'acc-owner' }])
		const logs = await logRows(s.ws.id)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({
			integration_id: row.id,
			actor_id: s.owner,
			session_id: null,
			outbound_target: 'unipile.test.invalid',
			action: 'read',
		})
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('an agent read that resolves through fallbackToAnyActor succeeds and writes one audit row for the agent', async () => {
		const s = await setup()
		const row = await seedLinkedIn(s.ws.id, s.owner, { accountId: 'acc-human' })
		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		// The agent has no row of its own: the read lands on the human's row.
		await send({ db, actorId: s.agent.id, workspaceId: s.ws.id }, 'k-fallback')

		expect(client.sendCalls).toEqual([{ account_id: 'acc-human' }])
		const logs = await logRows(s.ws.id)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({ integration_id: row.id, actor_id: s.agent.id })
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('a pinned fan-out identity read writes one audit row for the calling actor', async () => {
		const s = await setup()
		const row = await seedLinkedIn(s.ws.id, s.owner, { accountId: 'acc-pinned' })
		const client = recordingClient()
		__setLinkedInClientForTests(() => client)
		const identity: LinkedInMcpInstanceConfig = {
			workspaceId: s.ws.id,
			actorId: s.owner,
			integrationId: row.id,
			unipileAccountId: 'acc-pinned',
			unipileAccSlug: 'test-acc',
			identityType: 'personal',
			identityUrn: 'urn:li:person:test',
			identitySlug: 'personal',
			displayName: 'Test User',
			mailboxId: null,
			messagingEnabled: true,
		}

		await send({ db, actorId: s.agent.id, workspaceId: s.ws.id, identity }, 'k-pinned')

		expect(client.sendCalls).toEqual([{ account_id: 'acc-pinned' }])
		const logs = await logRows(s.ws.id)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({ integration_id: row.id, actor_id: s.agent.id })
	})

	it('a read the scope check denies throws ScopeDeniedError, writes no log row and one denied event', async () => {
		const s = await setup()
		await seedLinkedIn(s.ws.id, s.owner, { grants: [] })
		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		await expect(
			send({ db, actorId: s.owner, workspaceId: s.ws.id }, 'k-denied'),
		).rejects.toBeInstanceOf(ScopeDeniedError)

		expect(client.sendCalls).toHaveLength(0)
		expect(await logRows(s.ws.id)).toHaveLength(0)
		expect(await deniedEvents(s.ws.id)).toHaveLength(1)
	})

	it('a ctx from workspace B cannot read workspace A credential', async () => {
		const a = await setup()
		const b = await setup()
		const rowA = await seedLinkedIn(a.ws.id, a.owner)
		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		// Workspace B has no LinkedIn connection: the lookup is scoped to B.
		await expect(
			send({ db, actorId: b.agent.id, workspaceId: b.ws.id }, 'k-b'),
		).rejects.toMatchObject({
			code: 'CREDENTIAL_NOT_CONNECTED',
		})
		// Naming A's row directly with B's workspace finds nothing either.
		await expect(
			getCredential(db, b.ws.id, rowA.id, readContextFor(b.agent.id)),
		).rejects.toBeInstanceOf(CredentialNotFoundError)

		expect(client.sendCalls).toHaveLength(0)
		expect(await logRows(a.ws.id)).toHaveLength(0)
		expect(await logRows(b.ws.id)).toHaveLength(0)
	})

	it('a legacy row still reads, upgrades to envelope on writeEnvelopeCredential, and reads again', async () => {
		const s = await setup()
		const row = await seedLinkedIn(s.ws.id, s.owner, { accountId: 'acc-upgrade' })
		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		await send({ db, actorId: s.owner, workspaceId: s.ws.id }, 'k-before')
		await writeEnvelopeCredential(db, kms, {
			workspaceId: s.ws.id,
			integrationId: row.id,
			plaintext: JSON.stringify({ account_id: 'acc-upgrade', account_status: 'OK' }),
		})
		const [after] = await db.select().from(integrations).where(eq(integrations.id, row.id))
		expect(after.dekCiphertext).toBeTruthy()
		await send({ db, actorId: s.owner, workspaceId: s.ws.id }, 'k-after')

		expect(client.sendCalls).toEqual([{ account_id: 'acc-upgrade' }, { account_id: 'acc-upgrade' }])
		expect(await logRows(s.ws.id)).toHaveLength(2)
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 2 })
	})
})

describe('google-meet reads through getCredential', () => {
	it('resolveHostToken reads for the authenticated caller and writes one audit row', async () => {
		const s = await setup()
		const row = await seedMeet(s.ws.id, s.owner)

		const token = await resolveHostToken({ db, workspaceId: s.ws.id, actorId: s.agent.id })

		expect(token).toBe('fake-access-token-not-real')
		const logs = await logRows(s.ws.id)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({
			integration_id: row.id,
			actor_id: s.agent.id,
			session_id: null,
			outbound_target: 'meet.googleapis.com',
			action: 'read',
		})
		expect(await verifyCredentialAccessChain(db, s.ws.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('resolveHostToken fails closed with no authenticated actor and writes nothing', async () => {
		const s = await setup()
		await seedMeet(s.ws.id, s.owner)

		await expect(resolveHostToken({ db, workspaceId: s.ws.id })).rejects.toMatchObject({
			envelope: { error: { code: 'PERMISSION_DENIED' } },
		})
		expect(await logRows(s.ws.id)).toHaveLength(0)
	})

	it('getGoogleMeetAccessToken attributes the read to the caller, not to the actor_id override', async () => {
		const s = await setup()
		await seedMeet(s.ws.id, s.owner)

		await getGoogleMeetAccessToken(db, s.ws.id, s.owner, s.agent.id, 'www.googleapis.com')

		const logs = await logRows(s.ws.id)
		expect(logs).toHaveLength(1)
		expect(logs[0]).toMatchObject({ actor_id: s.agent.id, outbound_target: 'www.googleapis.com' })
	})

	it('getGoogleMeetAccessToken fails closed on an empty caller id and writes nothing', async () => {
		const s = await setup()
		await seedMeet(s.ws.id, s.owner)

		await expect(
			getGoogleMeetAccessToken(db, s.ws.id, null, '', 'meet.googleapis.com'),
		).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
		expect(await logRows(s.ws.id)).toHaveLength(0)
	})

	it('a read the scope check denies throws ScopeDeniedError, writes no log row and one denied event', async () => {
		const s = await setup()
		await seedMeet(s.ws.id, s.owner, [])

		await expect(
			resolveHostToken({ db, workspaceId: s.ws.id, actorId: s.agent.id }),
		).rejects.toBeInstanceOf(ScopeDeniedError)
		expect(await logRows(s.ws.id)).toHaveLength(0)
		expect(await deniedEvents(s.ws.id)).toHaveLength(1)
	})

	it('a ctx from workspace B cannot read workspace A credential', async () => {
		const a = await setup()
		const b = await setup()
		const rowA = await seedMeet(a.ws.id, a.owner)

		await expect(
			resolveHostToken({ db, workspaceId: b.ws.id, actorId: b.agent.id }),
		).rejects.toMatchObject({ envelope: { error: { code: 'INTEGRATION_MISSING' } } })
		await expect(
			getCredential(db, b.ws.id, rowA.id, readContextFor(b.agent.id)),
		).rejects.toBeInstanceOf(CredentialNotFoundError)

		expect(await logRows(a.ws.id)).toHaveLength(0)
		expect(await logRows(b.ws.id)).toHaveLength(0)
	})
})
