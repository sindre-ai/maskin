import {
	events,
	INTEGRATION_STATUS_ACTIVE,
	actors,
	integrations,
	workspaceMembers,
} from '@maskin/db/schema'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import {
	__resetLinkedInMcpRegistryForTests,
	getLinkedInMcpInstancesForIntegration,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	__setLinkedInClientForTests,
	sendLinkedInMessage,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { LinkedInClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

/**
 * P3-C · Access-gated fan-out — deregister on disconnect + per-call
 * integrations.status gate.
 *
 * Task: [P3-C](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/3a97d23e-7a06-4aed-8e47-873e284a06fa).
 *
 * Two-layer defense against post-disconnect access:
 *   1. DELETE /api/integrations/:id calls
 *      `deregisterLinkedInMcpInstancesForIntegration(existing.id)` so
 *      `tools/list` on the linkedin-unipile MCP endpoint no longer surfaces
 *      the disconnected credential's fan-out tools on the next request.
 *   2. Even if the registry entry survives (deregister missed by a race, a
 *      process running an older code path, or a persisted registry that has
 *      not caught up), the per-tool handler consults `integrations.status`
 *      at the start of each call and returns `INTEGRATION_DISCONNECTED`
 *      without hitting Unipile.
 *
 * Mocked-DB harnesses cannot cover this — the second defense hinges on the
 * `WHERE` clause in `preamble` selecting a row whose status has flipped in
 * real Postgres, and the first hinges on the DELETE handler's real `UPDATE
 * integrations SET status='revoked'` committing before the deregister call
 * fires.
 */

const ENCRYPTION_KEY = 'a'.repeat(64)

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.UNIPILE_BASE_URL = 'http://ignored-by-test-stub'
	process.env.UNIPILE_API_KEY = 'ignored-by-test-stub'
})

afterAll(() => {
	__setLinkedInClientForTests(null)
	__resetLinkedInMcpRegistryForTests()
})

beforeEach(() => {
	__setLinkedInClientForTests(null)
	__resetLinkedInMcpRegistryForTests()
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

/**
 * Same credential-query shape as `apps/dev/src/routes/integrations-linkedin-unipile-mcp.ts`.
 * A test that asserts on `tools/list` output through the MCP transport is
 * awkward (`StreamableHTTPServerTransport` needs Node req/res objects the
 * hono `app.request` harness does not provide), and the observable behaviour
 * the acceptance criterion asks about is exactly the union of instances this
 * query resolves to — asserting it directly against real Postgres is the
 * shape that cannot drift silently from the route.
 */
async function fanOutInstancesVisibleToMcpRoute(
	workspaceId: string,
): Promise<LinkedInMcpInstanceConfig[]> {
	const rows = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.provider, 'linkedin-unipile'),
				eq(integrations.status, INTEGRATION_STATUS_ACTIVE),
			),
		)
	return rows.flatMap((row) => getLinkedInMcpInstancesForIntegration(row.id))
}

describe('P3-C · fan-out disconnect gate (deregister on DELETE)', () => {
	it('DELETE /api/integrations/:id deregisters every fan-out MCP instance for that credential row', async () => {
		const ownerA = getTestActorId()
		const ws = await insertWorkspace(db, ownerA)

		// Two credentials in one workspace so the test proves the deregister is
		// scoped to `existing.id` and not "every linkedin-unipile row in the
		// workspace" — clobbering B on A's DELETE is the failure mode. Different
		// owning actors because `integrations_ws_actor_provider_null_external_uniq`
		// forbids two linkedin-unipile rows per (workspace, actor) pair.
		const rowA = await insertLinkedInIntegration(ws.id, ownerA, 'acc-A')
		const [ownerB] = await db
			.insert(actors)
			.values({
				type: 'human',
				name: 'Second Human P3C',
				email: 'second-p3c@test.com',
				apiKey: 'ank_second_p3c',
			})
			.returning()
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: ownerB.id, role: 'member' })
		const rowB = await insertLinkedInIntegration(ws.id, ownerB.id, 'acc-B')

		const personalA = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: ownerA,
			integrationId: rowA.id,
			unipileAccountId: 'acc-A',
			unipileAccSlug: 'human-a',
			identitySlug: 'personal',
			identityUrn: 'urn:li:person:a',
			displayName: 'Human A',
		})
		const pageA = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: ownerA,
			integrationId: rowA.id,
			unipileAccountId: 'acc-A',
			unipileAccSlug: 'human-a',
			identitySlug: 'acme-page',
			identityType: 'company_page',
			identityUrn: 'urn:li:organization:1',
			displayName: 'Acme Page',
		})
		const personalB = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: ownerB.id,
			integrationId: rowB.id,
			unipileAccountId: 'acc-B',
			unipileAccSlug: 'human-b',
			identitySlug: 'personal',
			identityUrn: 'urn:li:person:b',
			displayName: 'Human B',
		})
		registerLinkedInMcpInstance(personalA)
		registerLinkedInMcpInstance(pageA)
		registerLinkedInMcpInstance(personalB)

		expect(getLinkedInMcpInstancesForIntegration(rowA.id)).toHaveLength(2)
		expect(getLinkedInMcpInstancesForIntegration(rowB.id)).toHaveLength(1)

		const { default: integrationsRoutes } = await import('../../routes/integrations')
		const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
		const res = await app.request(
			new Request(`http://localhost/api/integrations/${rowA.id}`, {
				method: 'DELETE',
				headers: { 'X-Workspace-Id': ws.id },
			}),
		)
		expect(res.status).toBe(200)

		// Every instance owned by A is gone; B is untouched.
		expect(getLinkedInMcpInstancesForIntegration(rowA.id)).toEqual([])
		expect(getLinkedInMcpInstancesForIntegration(rowB.id)).toHaveLength(1)

		// And the credential row is `revoked`, which is the load-bearing state
		// the per-call gate below reads. Not just deleted — a hard delete would
		// lose the audit trail and the reconnect UX.
		const [afterDelete] = await db
			.select({ status: integrations.status })
			.from(integrations)
			.where(eq(integrations.id, rowA.id))
		expect(afterDelete.status).toBe('revoked')

		// tools/list surface: only B's instance is visible now.
		const visible = await fanOutInstancesVisibleToMcpRoute(ws.id)
		expect(visible.map((i) => i.integrationId)).toEqual([rowB.id])
	})

	it('tools/list filters out a revoked credential row even if the fan-out registry still holds its instances', async () => {
		// Belt to the DELETE deregister's braces (tech principles doc core
		// principle 3): `integrations.status` is the truth, the in-process
		// registry is a performance cache. This case simulates the failure mode
		// where the deregister step was missed — a hot reload, a persisted
		// registry that has not caught up, or a race between the DB commit and
		// the deregister — and asserts that the status filter alone is enough
		// to hide the stale instances.
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner)
		const row = await insertLinkedInIntegration(ws.id, owner, 'acc-orphan')

		const cfg = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: owner,
			integrationId: row.id,
			unipileAccountId: 'acc-orphan',
		})
		registerLinkedInMcpInstance(cfg)

		// Flip status directly; do NOT deregister. The registry still holds cfg.
		await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, row.id))
		expect(getLinkedInMcpInstancesForIntegration(row.id)).toHaveLength(1)

		expect(await fanOutInstancesVisibleToMcpRoute(ws.id)).toEqual([])
	})

	it('is a no-op when disconnecting a credential with no registered instances', async () => {
		// A credential whose enumeration never landed still needs to disconnect
		// cleanly — the deregister call is idempotent (returns 0), so the DELETE
		// route must not surface an error for the empty case.
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner)
		const row = await insertLinkedInIntegration(ws.id, owner, 'acc-empty')

		const { default: integrationsRoutes } = await import('../../routes/integrations')
		const app = createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
		const res = await app.request(
			new Request(`http://localhost/api/integrations/${row.id}`, {
				method: 'DELETE',
				headers: { 'X-Workspace-Id': ws.id },
			}),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { deleted: boolean }
		expect(body.deleted).toBe(true)

		// Audit trail: an `updated` event with reason `user_disconnected` is
		// what tells the settings SSE feed to invalidate — without it the UI
		// reads as connected until something else nudges the cache. Same rule
		// the mcp-detach / TokenManager.markRevoked entries in known-pitfalls
		// call out.
		const auditRows = await db
			.select({ data: events.data })
			.from(events)
			.where(and(eq(events.entityType, 'integration'), eq(events.entityId, row.id)))
		expect(
			auditRows.some((r) => (r.data as { reason?: string }).reason === 'user_disconnected'),
		).toBe(true)
	})
})

describe('P3-C · per-call integrations.status gate (preamble)', () => {
	it('returns INTEGRATION_DISCONNECTED without hitting Unipile when the credential row is revoked', async () => {
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner)
		const row = await insertLinkedInIntegration(ws.id, owner, 'acc-revoked')

		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		const identity = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: owner,
			integrationId: row.id,
			unipileAccountId: 'acc-revoked',
			identitySlug: 'personal',
			displayName: 'Revoked Human',
		})

		// User disconnected — row still exists (needed for the audit trail and
		// the reconnect flow), but status is no longer `active`. The gate reads
		// that at every call so a fan-out MCP instance still in the registry
		// cannot send.
		await db.update(integrations).set({ status: 'revoked' }).where(eq(integrations.id, row.id))

		await expect(
			sendLinkedInMessage(
				{ db, actorId: owner, workspaceId: ws.id, identity },
				{ recipient_urn: 'urn:li:person:target', body: 'x', idempotency_key: 'k-revoked' },
			),
		).rejects.toMatchObject({ code: 'INTEGRATION_DISCONNECTED' })

		// Load-bearing: the revoked credential MUST NEVER reach Unipile. Even
		// one successful send after a disconnect is the whole bug this task
		// exists to close (insight #4).
		expect(client.sendCalls).toHaveLength(0)
	})

	it('returns INTEGRATION_DISCONNECTED when the credential row was deleted outright', async () => {
		// A row that has been hard-deleted (as opposed to soft-revoked) is the
		// same story to the fan-out instance — the identity it was registered
		// against no longer exists. The gate must not fall through to the
		// legacy CREDENTIAL_NOT_CONNECTED path here: the caller had a fan-out
		// MCP instance, so "never connected" is not the right story either.
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner)
		const row = await insertLinkedInIntegration(ws.id, owner, 'acc-deleted')

		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		const identity = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: owner,
			integrationId: row.id,
			unipileAccountId: 'acc-deleted',
		})

		await db.delete(integrations).where(eq(integrations.id, row.id))

		await expect(
			sendLinkedInMessage(
				{ db, actorId: owner, workspaceId: ws.id, identity },
				{ recipient_urn: 'urn:li:person:target', body: 'x', idempotency_key: 'k-deleted' },
			),
		).rejects.toMatchObject({ code: 'INTEGRATION_DISCONNECTED' })

		expect(client.sendCalls).toHaveLength(0)
	})

	it('lets the call through when the credential row is still active', async () => {
		// Pins the happy path so a future tightening of the gate cannot break
		// active sends. Without this, "INTEGRATION_DISCONNECTED on revoked
		// rows" could be met by returning it on every row.
		const owner = getTestActorId()
		const ws = await insertWorkspace(db, owner)
		const row = await insertLinkedInIntegration(ws.id, owner, 'acc-active')

		const client = recordingClient()
		__setLinkedInClientForTests(() => client)

		const identity = fakeInstanceConfig({
			workspaceId: ws.id,
			actorId: owner,
			integrationId: row.id,
			unipileAccountId: 'acc-active',
		})

		await sendLinkedInMessage(
			{ db, actorId: owner, workspaceId: ws.id, identity },
			{ recipient_urn: 'urn:li:person:target', body: 'x', idempotency_key: 'k-active' },
		)
		expect(client.sendCalls).toEqual([{ account_id: 'acc-active' }])
	})
})
