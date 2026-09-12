import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * P3-B · Symmetric disconnect — asserts the Unipile v2 DELETE-account is
 * invoked during the linkedin-unipile disconnect handler, with best-effort
 * semantics: 404 (already gone upstream) and 5xx never block the local
 * disconnect.
 *
 * Uses the in-process Unipile mock (`__mocks__/unipile-server.ts`) so the
 * exact wire path (`DELETE /v2/accounts/{account_id}`) is exercised, the way
 * every other LinkedIn-unipile suite in this bet does. The 404 and 5xx
 * branches are forced via `setNext(…)` planted overrides so the mock serves
 * the real shape rather than a convenient success (per
 * `.claude/rules/live-verification.md`: "a test double you wrote cannot
 * verify your model of the provider is correct").
 *
 * Also pins the R11-C 403 safety-net delegation: when the safety-net's
 * re-enumeration returns ZERO surviving identities, the safety-net calls
 * `deleteAccount` (best-effort) — closing the whole orphaned Unipile account
 * per the P3-B "R11-C's PAGE_ADMIN_REVOKED flow calls deleteAccount" AC. A
 * safety-net firing where identities remain does NOT delete the account
 * (spec §1.4: a single-page revoke leaves personal + sibling pages valid).
 */

// Register the fake logger BEFORE any module import so the runtime module reads
// it. The disconnect hook writes structured log lines that the acceptance
// criterion pins ("structured log line at info level naming the account id +
// outcome") — we assert on the recorded calls.
const logCalls = {
	info: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
	warn: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
	error: [] as Array<{ msg: string; ctx: Record<string, unknown> }>,
}
vi.mock('../../lib/logger', () => ({
	logger: {
		info: (msg: string, ctx: Record<string, unknown> = {}) => {
			logCalls.info.push({ msg, ctx })
		},
		warn: (msg: string, ctx: Record<string, unknown> = {}) => {
			logCalls.warn.push({ msg, ctx })
		},
		error: (msg: string, ctx: Record<string, unknown> = {}) => {
			logCalls.error.push({ msg, ctx })
		},
		debug: vi.fn(),
	},
}))

// Crypto identity-mock so the safety-net's `handleUnipileAccountReconnect`
// path can decrypt the seeded `credentials` (which the fake DB stores as
// plaintext JSON). Same pattern the R11-C page-admin-revoke suite uses.
vi.mock('../../lib/crypto', () => ({
	decrypt: (s: string) => s,
	encrypt: (s: string) => s,
}))

import {
	type LinkedInMockServer,
	planManagedPagesResponse,
	resetManagedPagesResponse,
	startLinkedInMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import {
	__setLinkedInDisconnectClientForTests,
	deleteUnipileAccountOnDisconnect,
} from '../../lib/integrations/providers/linkedin-unipile/disconnect'
import { createLinkedInHttpClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import type { StoredCredentials } from '../../lib/integrations/types'

const WORKSPACE_ID = '22222222-2222-2222-2222-222222222222'
const INTEGRATION_ID = '11111111-1111-1111-1111-111111111111'
const ACCOUNT_ID = 'acc_01m2abxfsymmetric'

function makeCtx(
	overrides: Partial<{
		externalId: string | null
		credentials: StoredCredentials
	}> = {},
) {
	// Uses explicit `in` checks (not `??`) so a caller passing `externalId: null`
	// stays null instead of getting silently reset to the default account id.
	const externalId = 'externalId' in overrides ? overrides.externalId : ACCOUNT_ID
	const credentials =
		'credentials' in overrides
			? (overrides.credentials as StoredCredentials)
			: ({ account_id: ACCOUNT_ID } as unknown as StoredCredentials)
	return {
		db: {} as unknown,
		integrationId: INTEGRATION_ID,
		workspaceId: WORKSPACE_ID,
		credentials,
		externalId: externalId as string | null,
	}
}

describe('P3-B · deleteUnipileAccountOnDisconnect (preDisconnect hook)', () => {
	let mock: LinkedInMockServer

	beforeEach(async () => {
		mock = await startLinkedInMock()
		__setLinkedInDisconnectClientForTests(() =>
			createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
		logCalls.info.length = 0
		logCalls.warn.length = 0
		logCalls.error.length = 0
	})

	afterEach(async () => {
		await mock.close()
		__setLinkedInDisconnectClientForTests(null)
	})

	it('calls DELETE /v2/accounts/{account_id} with externalId (happy path)', async () => {
		await deleteUnipileAccountOnDisconnect(makeCtx())

		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toBe(`/v2/accounts/${ACCOUNT_ID}`)

		const infoLogs = logCalls.info.filter((l) => l.msg.includes('deleteAccount'))
		expect(infoLogs).toHaveLength(1)
		expect(infoLogs[0]?.msg).toContain('deleted upstream')
		expect(infoLogs[0]?.ctx.accountId).toBe(ACCOUNT_ID)
		expect(infoLogs[0]?.ctx.reason).toBe('disconnect')
	})

	it('falls back to credentials.account_id when externalId is null (pre-R11 rows)', async () => {
		await deleteUnipileAccountOnDisconnect(
			makeCtx({
				externalId: null,
				credentials: { account_id: ACCOUNT_ID } as unknown as StoredCredentials,
			}),
		)

		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toBe(`/v2/accounts/${ACCOUNT_ID}`)
	})

	it('logs-and-continues on 404 (already deleted upstream) — never throws', async () => {
		mock.setNext('delete-account-already-gone')

		await expect(deleteUnipileAccountOnDisconnect(makeCtx())).resolves.toBeUndefined()

		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		const alreadyGone = logCalls.info.find((l) => l.msg.includes('already gone upstream'))
		expect(alreadyGone).toBeDefined()
		expect(alreadyGone?.ctx.accountId).toBe(ACCOUNT_ID)
		expect(alreadyGone?.ctx.reason).toBe('disconnect')
	})

	it('logs-and-continues on a 5xx (transient Unipile-side error) — never throws', async () => {
		mock.setNext('delete-account-unavailable')

		await expect(deleteUnipileAccountOnDisconnect(makeCtx())).resolves.toBeUndefined()

		const warnLog = logCalls.warn.find((l) => l.msg.includes('upstream error'))
		expect(warnLog).toBeDefined()
		expect(warnLog?.ctx.status).toBe(503)
		expect(warnLog?.ctx.reason).toBe('disconnect')
	})

	it('no-ops silently when neither externalId nor credentials.account_id is set', async () => {
		await deleteUnipileAccountOnDisconnect(
			makeCtx({ externalId: null, credentials: {} as unknown as StoredCredentials }),
		)

		expect(mock.inbox().filter((r) => r.method === 'DELETE')).toHaveLength(0)
		const skipped = logCalls.info.find((l) => l.msg.includes('no Unipile account id'))
		expect(skipped).toBeDefined()
	})

	it('warns and continues when UNIPILE env is missing (no client can be built)', async () => {
		// Drop the test-only override and force the real builder to fail.
		__setLinkedInDisconnectClientForTests(null)
		const originalBaseUrl = process.env.UNIPILE_BASE_URL
		const originalApiKey = process.env.UNIPILE_API_KEY
		process.env.UNIPILE_BASE_URL = ''
		process.env.UNIPILE_API_KEY = ''
		try {
			await deleteUnipileAccountOnDisconnect(makeCtx())
			expect(mock.inbox().filter((r) => r.method === 'DELETE')).toHaveLength(0)
			const warn = logCalls.warn.find((l) => l.msg.includes('Unipile client not configured'))
			expect(warn).toBeDefined()
		} finally {
			if (originalBaseUrl === undefined) process.env.UNIPILE_BASE_URL = undefined
			else process.env.UNIPILE_BASE_URL = originalBaseUrl
			if (originalApiKey === undefined) process.env.UNIPILE_API_KEY = undefined
			else process.env.UNIPILE_API_KEY = originalApiKey
		}
	})
})

describe('P3-B · registry wires preDisconnect for linkedin-unipile', () => {
	it('getProvider("linkedin-unipile").preDisconnect is defined', async () => {
		const { getProvider } = await import('../../lib/integrations/registry')
		const resolved = getProvider('linkedin-unipile')
		expect(resolved.preDisconnect).toBeDefined()
	})
})

describe('P3-B · PAGE_ADMIN_REVOKED delegation (R11-C safety-net)', () => {
	let mock: LinkedInMockServer

	beforeEach(async () => {
		mock = await startLinkedInMock()
		__setLinkedInDisconnectClientForTests(() =>
			createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
		// The safety-net path uses the WEBHOOK client for its re-enumeration
		// AND for the deleteAccount call (both go through the same Unipile-level
		// surface). Point the webhook builder at the same mock.
		const webhook = await import('../../lib/integrations/providers/linkedin-unipile/webhook')
		webhook.__setLinkedInWebhookClientForTests(() =>
			createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
		resetManagedPagesResponse()
		logCalls.info.length = 0
		logCalls.warn.length = 0
	})

	afterEach(async () => {
		await mock.close()
		__setLinkedInDisconnectClientForTests(null)
		const webhook = await import('../../lib/integrations/providers/linkedin-unipile/webhook')
		webhook.__setLinkedInWebhookClientForTests(null)
		resetManagedPagesResponse()
		const registry = await import('@maskin/mcp/linkedin')
		registry.__resetLinkedInMcpRegistryForTests()
	})

	function buildFakeDb(rows: Array<Record<string, unknown>>) {
		return {
			select: () => ({
				from: () => ({
					where: () => Promise.resolve(rows),
				}),
			}),
		} as unknown as import('@maskin/db').Database
	}

	it('deleteAccount fires when re-enumeration returns ZERO surviving identities (whole account orphaned)', async () => {
		const { withPageAdminRevokeSafetyNet } = await import(
			'../../lib/integrations/providers/linkedin-unipile/operations'
		)
		const { PageAdminRevokedError } = await import(
			'../../lib/integrations/providers/linkedin-unipile/errors'
		)
		const { registerLinkedInMcpInstance } = await import('@maskin/mcp/linkedin')

		const cfg = {
			workspaceId: WORKSPACE_ID,
			actorId: '33333333-3333-3333-3333-333333333333',
			integrationId: INTEGRATION_ID,
			unipileAccountId: ACCOUNT_ID,
			unipileAccSlug: 'acc-slug',
			identityType: 'company_page' as const,
			identityUrn: 'urn:li:organization:11111111',
			identitySlug: 'maskinio',
			displayName: 'Maskin',
			mailboxId: 'mock-mailbox-1',
			messagingEnabled: true,
		}
		registerLinkedInMcpInstance(cfg)

		const db = buildFakeDb([
			{
				id: INTEGRATION_ID,
				workspaceId: WORKSPACE_ID,
				actorId: '33333333-3333-3333-3333-333333333333',
				provider: 'linkedin-unipile',
				status: 'active',
				externalId: ACCOUNT_ID,
				credentials: JSON.stringify({ account_id: ACCOUNT_ID }),
				unipileAccSlug: 'acc-slug',
				createdBy: '33333333-3333-3333-3333-333333333333',
			},
		])

		// Force the re-enumeration to return zero identities: personal profile
		// call still succeeds (200) but the mock's default returns a valid
		// personal identity. We need /users/me to also return empty so the
		// enumeration lands with 0 identities. planManagedPagesResponse only
		// controls the pages route; readPersonalIdentity returns null when
		// public_identifier is missing, so we plant an override on /users/me.
		// The simplest way to force 0 identities is: plant empty pages AND
		// override /users/me. Since the mock's default me-profile has
		// public_identifier, we need an override.
		const { planResponseOverride } = await import(
			'../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
		)
		planResponseOverride({
			match: (m, p) => m === 'GET' && /^\/v2\/[^/]+\/users\/me(\?.*)?$/.test(p),
			status: 200,
			body: { object: 'UserProfile' }, // no provider_id/public_identifier → readPersonalIdentity returns null
		})
		planManagedPagesResponse([])
		mock.setNext('page-admin-revoked')

		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const call = () =>
			client.publishPost({ account_id: ACCOUNT_ID, text: 'x', post_as: cfg.identityUrn })

		await expect(withPageAdminRevokeSafetyNet(db, cfg, call as never)).rejects.toBeInstanceOf(
			PageAdminRevokedError,
		)

		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toBe(`/v2/accounts/${ACCOUNT_ID}`)
	})

	it('deleteAccount does NOT fire when personal + sibling pages remain (single-page revoke)', async () => {
		const { withPageAdminRevokeSafetyNet } = await import(
			'../../lib/integrations/providers/linkedin-unipile/operations'
		)
		const { PageAdminRevokedError } = await import(
			'../../lib/integrations/providers/linkedin-unipile/errors'
		)
		const { registerLinkedInMcpInstance } = await import('@maskin/mcp/linkedin')

		const cfg = {
			workspaceId: WORKSPACE_ID,
			actorId: '33333333-3333-3333-3333-333333333333',
			integrationId: INTEGRATION_ID,
			unipileAccountId: ACCOUNT_ID,
			unipileAccSlug: 'acc-slug',
			identityType: 'company_page' as const,
			identityUrn: 'urn:li:organization:aaaa',
			identitySlug: 'page-a',
			displayName: 'Page A',
			mailboxId: 'mock-mailbox-a',
			messagingEnabled: true,
		}
		registerLinkedInMcpInstance(cfg)

		const db = buildFakeDb([
			{
				id: INTEGRATION_ID,
				workspaceId: WORKSPACE_ID,
				actorId: '33333333-3333-3333-3333-333333333333',
				provider: 'linkedin-unipile',
				status: 'active',
				externalId: ACCOUNT_ID,
				credentials: JSON.stringify({ account_id: ACCOUNT_ID }),
				unipileAccSlug: 'acc-slug',
				createdBy: '33333333-3333-3333-3333-333333333333',
			},
		])

		// /users/me default returns a valid personal identity. Pages returns
		// pageB only (pageA was revoked). Personal + pageB survive.
		planManagedPagesResponse([
			{
				id: 'mock-page-b',
				provider_id: 'bbbb',
				public_identifier: 'page-b',
				name: 'Page B',
				messaging_enabled: true,
				mailbox_id: 'mock-mailbox-b',
			},
		])
		mock.setNext('page-admin-revoked')

		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const call = () =>
			client.publishPost({ account_id: ACCOUNT_ID, text: 'x', post_as: cfg.identityUrn })

		await expect(withPageAdminRevokeSafetyNet(db, cfg, call as never)).rejects.toBeInstanceOf(
			PageAdminRevokedError,
		)

		// No DELETE fired: the account has surviving identities upstream.
		const deletes = mock.inbox().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(0)
	})
})
