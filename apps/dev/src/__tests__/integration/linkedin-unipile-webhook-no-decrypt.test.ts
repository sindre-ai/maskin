import { INTEGRATION_STATUS_ACTIVE, integrations } from '@maskin/db/schema'
import { __resetLinkedInMcpRegistryForTests } from '@maskin/mcp/linkedin'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Wrap the real decrypt in a spy so the test can count calls and still let
// getCredential (used once below to seed an audit row) work.
const cryptoSpy = vi.hoisted(() => ({ decrypt: vi.fn() }))
vi.mock('../../lib/crypto', async () => {
	const actual = await vi.importActual<typeof import('../../lib/crypto')>('../../lib/crypto')
	cryptoSpy.decrypt.mockImplementation(actual.decrypt)
	return { ...actual, decrypt: cryptoSpy.decrypt }
})

import { encrypt } from '../../lib/crypto'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { getCredential } from '../../lib/integrations/lookup'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { handleUnipileAccountReconnect } from '../../lib/integrations/providers/linkedin-unipile/webhook'
import { readContextFor } from '../../lib/integrations/read-context'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * account.reconnect webhook: the handler takes the Unipile account id from the
 * row's external_id and never reads a credential. No decrypt call, no
 * credential_access_log row, and the audit chain of a workspace that has had a
 * delivery still verifies from genesis to head. Values are obviously fake.
 */

const ACCOUNT_ID = 'acc-webhook-shared'

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
})

beforeEach(() => {
	__resetLinkedInMcpRegistryForTests()
})

afterEach(() => {
	__resetLinkedInMcpRegistryForTests()
})

async function seedRow(
	workspaceId: string,
	actorId: string,
	opts: { unipileAccSlug: string | null; credentials?: string; status?: string },
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'linkedin-unipile',
			status: opts.status ?? INTEGRATION_STATUS_ACTIVE,
			credentials: opts.credentials ?? encrypt(JSON.stringify({ account_id: ACCOUNT_ID })),
			externalId: ACCOUNT_ID,
			unipileAccSlug: opts.unipileAccSlug,
			actorId,
			createdBy: actorId,
		})
		.returning()
	return row
}

function enumerationClient(): LinkedInClient {
	return {
		getProfile: async () => ({
			status: 200,
			body: { provider_id: 'person-1', public_identifier: 'fake-person', first_name: 'Fake' },
			headers: {},
		}),
		getManagedCompanyPages: async () => ({ status: 200, body: { data: [] }, headers: {} }),
	} as unknown as LinkedInClient
}

const logCount = async (workspaceId: string) => {
	const [r] = await sql<{ n: number }[]>`
		SELECT count(*)::int AS n FROM credential_access_log WHERE workspace_id = ${workspaceId}
	`
	return r.n
}

describe('account.reconnect webhook reads no credential', () => {
	it('re-enumerates every active row, one appliedTo entry per row, with zero decrypts and zero audit rows', async () => {
		const owner = getTestActorId()
		const wsA = await insertWorkspace(db, owner)
		const wsB = await insertWorkspace(db, owner)
		const wsC = await insertWorkspace(db, owner)
		const rowA = await seedRow(wsA.id, owner, { unipileAccSlug: 'slug-a' })
		const rowB = await seedRow(wsB.id, owner, { unipileAccSlug: 'slug-b' })
		// Not yet slugged: skipped, but still one entry.
		const rowC = await seedRow(wsC.id, owner, { unipileAccSlug: null })
		// A credential blob that cannot be decrypted no longer matters to the webhook.
		const wsD = await insertWorkspace(db, owner)
		const rowD = await seedRow(wsD.id, owner, {
			unipileAccSlug: 'slug-d',
			credentials: 'not-a-decryptable-blob',
		})
		// Inactive rows are not part of the fan-out.
		const wsE = await insertWorkspace(db, owner)
		await seedRow(wsE.id, owner, { unipileAccSlug: 'slug-e', status: 'revoked' })

		// One audited read in workspace A, so its chain has a row to verify.
		await getCredential(db, wsA.id, rowA.id, readContextFor(owner))
		expect(await logCount(wsA.id)).toBe(1)

		cryptoSpy.decrypt.mockClear()
		const result = await handleUnipileAccountReconnect(db, enumerationClient(), ACCOUNT_ID)

		expect(cryptoSpy.decrypt).not.toHaveBeenCalled()
		expect(result.appliedTo).toHaveLength(4)
		const byId = new Map(result.appliedTo.map((e) => [e.integrationId, e]))
		expect(byId.get(rowA.id)).toMatchObject({ workspaceId: wsA.id })
		expect(byId.get(rowB.id)).toMatchObject({ workspaceId: wsB.id })
		expect(byId.get(rowD.id)).toMatchObject({ workspaceId: wsD.id })
		for (const id of [rowA.id, rowB.id, rowD.id]) {
			const diff = byId.get(id)?.diff
			expect(diff && 'registered' in diff && diff.registered.length).toBeGreaterThan(0)
		}
		expect(byId.get(rowC.id)?.diff).toEqual({ error: 'MISSING_UNIPILE_ACC_SLUG' })

		// The webhook wrote nothing to the audit log; workspace A still has its one row.
		expect(await logCount(wsA.id)).toBe(1)
		for (const ws of [wsB, wsC, wsD, wsE]) expect(await logCount(ws.id)).toBe(0)
		expect(await verifyCredentialAccessChain(db, wsA.id)).toMatchObject({ ok: true, rows: 1 })
	})

	it('returns an empty appliedTo when no active row carries the account id', async () => {
		cryptoSpy.decrypt.mockClear()
		const result = await handleUnipileAccountReconnect(db, enumerationClient(), 'acc-nobody')
		expect(result).toEqual({ appliedTo: [] })
		expect(cryptoSpy.decrypt).not.toHaveBeenCalled()
	})
})
