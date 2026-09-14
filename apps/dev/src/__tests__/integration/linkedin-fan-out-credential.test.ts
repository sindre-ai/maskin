import {
	INTEGRATION_STATUS_ACTIVE,
	actors,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	__setLinkedInClientForTests,
	sendLinkedInMessage,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * P3-G · Fan-out tools use the instance's own credential — operations layer
 * stops resolving by calling actor.
 *
 * Task: [P3-G](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/5d6c073d-9432-43f3-aae4-0cf9cf02317c).
 *
 * Two active linkedin-unipile rows in one workspace (A older, B newer). A call
 * through identity B's `LinkedInMcpInstanceConfig` must reach Unipile with B's
 * `account_id`; the same call through identity A's config must reach Unipile
 * with A's `account_id`. Without the identity-scoped preamble path this fails:
 * `getIntegrationCredential`'s `fallbackToAnyActor` picks the oldest active row
 * for both, so every fan-out tool sends as identity A regardless of the tool
 * name promised — see the parent bet's Sept-11 dogfood insight where
 * `linkedin-magnus-noeddegaard-personal__get_profile('me')` returned Sebastian's
 * URN because Sebastian's credential was the oldest active row.
 *
 * Mocked-DB harnesses cannot cover this — the bug is exactly a `WHERE` clause
 * against `integrations` selecting the wrong row, and only a real Postgres
 * insert / SELECT round-trip proves that identity B's `integrationId` on the
 * config resolves to B's `account_id` and not A's.
 */

const ENCRYPTION_KEY = 'a'.repeat(64)

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.UNIPILE_BASE_URL = 'http://ignored-by-test-stub'
	process.env.UNIPILE_API_KEY = 'ignored-by-test-stub'
})

afterAll(() => {
	__setLinkedInClientForTests(null)
})

beforeEach(() => {
	__setLinkedInClientForTests(null)
})

async function insertLinkedInIntegration(
	workspaceId: string,
	actorId: string,
	accountId: string,
): Promise<{ id: string }> {
	const credentialsBlob = encrypt(
		JSON.stringify({
			account_id: accountId,
			account_status: 'OK',
		}),
	)
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'linkedin-unipile',
			status: INTEGRATION_STATUS_ACTIVE,
			credentials: credentialsBlob,
			actorId,
			createdBy: actorId,
		})
		.returning()
	return row
}

function fakeInstanceConfig(
	overrides: Partial<LinkedInMcpInstanceConfig> & {
		workspaceId: string
		actorId: string
		integrationId: string
		unipileAccountId: string
	},
): LinkedInMcpInstanceConfig {
	return {
		unipileAccSlug: 'test-acc',
		identityType: 'personal',
		identityUrn: 'urn:li:person:test',
		identitySlug: 'personal',
		displayName: 'Test User',
		mailboxId: null,
		messagingEnabled: true,
		...overrides,
	}
}

function recordingClient(): LinkedInClient & { sendCalls: Array<{ account_id: string }> } {
	const sendCalls: Array<{ account_id: string }> = []
	const client: LinkedInClient = {
		sendMessage: async (payload) => {
			sendCalls.push({ account_id: payload.account_id })
			return {
				status: 200,
				body: {
					object: 'ChatStarted',
					message_id: 'stub-message',
					chat_id: 'stub-chat',
				},
				headers: {},
			}
		},
		reply: vi.fn(),
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		listRelations: vi.fn(),
		searchPeople: vi.fn(),
		getProfile: vi.fn(),
		getManagedCompanyPages: vi.fn(),
		sendConnectionRequest: vi.fn(),
		publishPost: vi.fn(),
		commentOnPost: vi.fn(),
		replyToComment: vi.fn(),
		readPostComments: vi.fn(),
		retrievePost: vi.fn(),
		listReactions: vi.fn(),
		countComments: vi.fn(),
		editPost: vi.fn(),
		deletePost: vi.fn(),
	}
	return Object.assign(client, { sendCalls })
}

describe('preamble identity-scoped credential lookup (P3-G)', () => {
	it('routes each fan-out identity to its own credential row, not the oldest', async () => {
		const ownerA = getTestActorId()
		const ws = await insertWorkspace(db, ownerA)

		// Two connected LinkedIn accounts in one workspace, owned by different
		// humans. A is inserted first (older); B second (newer). The pre-P3-G
		// preamble path picks A for both — that is the whole bug.
		const rowA = await insertLinkedInIntegration(ws.id, ownerA, 'acc-A')
		const [ownerB] = await db
			.insert(actors)
			.values({
				type: 'human',
				name: 'Second Human',
				email: 'second@test.com',
				apiKey: 'ank_second_p3g',
			})
			.returning()
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: ownerB.id,
			role: 'member',
		})
		const rowB = await insertLinkedInIntegration(ws.id, ownerB.id, 'acc-B')

		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		const identityA = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: ownerA,
			integrationId: rowA.id,
			unipileAccountId: 'acc-A',
			unipileAccSlug: 'human-a',
			identityUrn: 'urn:li:person:a',
			displayName: 'Human A',
		})
		const identityB = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: ownerB.id,
			integrationId: rowB.id,
			unipileAccountId: 'acc-B',
			unipileAccSlug: 'human-b',
			identityUrn: 'urn:li:person:b',
			displayName: 'Human B',
		})

		// Same calling actor (an agent) — the split MUST come from `ctx.identity`,
		// not from `ctx.actorId`.
		await sendLinkedInMessage(
			{ db, actorId: ownerA, workspaceId: ws.id, identity: identityB },
			{ recipient_urn: 'urn:li:person:target', body: 'from B', idempotency_key: 'k-b-1' },
		)
		await sendLinkedInMessage(
			{ db, actorId: ownerA, workspaceId: ws.id, identity: identityA },
			{ recipient_urn: 'urn:li:person:target', body: 'from A', idempotency_key: 'k-a-1' },
		)

		expect(client.sendCalls.map((c) => c.account_id)).toEqual(['acc-B', 'acc-A'])
	})

	it('fails closed when the row account_id has drifted from the registered instance', async () => {
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner)
		// Row holds acc-CURRENT (a reconnect happened after the MCP instance was
		// registered against the previous account).
		const row = await insertLinkedInIntegration(ws.id, owner, 'acc-CURRENT')

		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		const staleIdentity = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: owner,
			integrationId: row.id,
			unipileAccountId: 'acc-STALE',
			unipileAccSlug: 'sebastian',
			identityUrn: 'urn:li:person:stale',
			displayName: 'Stale Identity',
		})

		await expect(
			sendLinkedInMessage(
				{ db, actorId: owner, workspaceId: ws.id, identity: staleIdentity },
				{ recipient_urn: 'urn:li:person:target', body: 'x', idempotency_key: 'k-drift' },
			),
		).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONNECTED' })

		// Load-bearing: the wrong account_id must NEVER reach Unipile.
		expect(client.sendCalls).toHaveLength(0)
	})

	it('returns CREDENTIAL_NOT_CONNECTED when the identity points at a row in a different workspace', async () => {
		const owner = getTestActorId()
		const wsA = await insertWorkspace(db, owner)
		const wsB = await insertWorkspace(db, owner)
		const rowInB = await insertLinkedInIntegration(wsB.id, owner, 'acc-in-B')

		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		// An identity pinned to a row in wsB must never resolve for a caller in
		// wsA — the workspace guard on the preamble select is load-bearing.
		const identityCrossWs = fakeInstanceConfig({
			workspaceId: wsB.id,
			actorId: owner,
			integrationId: rowInB.id,
			unipileAccountId: 'acc-in-B',
		})

		await expect(
			sendLinkedInMessage(
				{ db, actorId: owner, workspaceId: wsA.id, identity: identityCrossWs },
				{ recipient_urn: 'urn:li:person:target', body: 'x', idempotency_key: 'k-x' },
			),
		).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONNECTED' })
		expect(client.sendCalls).toHaveLength(0)
	})
})
