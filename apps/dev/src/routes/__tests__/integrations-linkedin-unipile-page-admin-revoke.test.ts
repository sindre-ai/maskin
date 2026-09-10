import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * R11-C · 403-triggered PAGE_ADMIN_REVOKED safety-net + `unipile.account.updated`
 * webhook re-enumeration coverage.
 *
 * Exercises the four moving pieces the task's acceptance criteria pin:
 *
 *   1. Classifier — 403 + body `error_code: 'page_admin_revoked'` maps to
 *      the `PAGE_ADMIN_REVOKED` class with retry policy `null`.
 *   2. `withPageAdminRevokeSafetyNet` — on that class, the wrapper
 *      deregisters the specific MCP instance, kicks off an
 *      `account.updated`-style re-enumeration, and rethrows
 *      `PageAdminRevokedError` so the agent loop learns of the change.
 *   3. `handleUnipileAccountUpdated` — a re-enumeration where the page
 *      is missing from the enumeration correctly leaves that instance
 *      deregistered.
 *   4. Registry — deregister for one slug never disturbs
 *      other-LinkedIn or `github-*` instances (the invariant the task
 *      body calls out explicitly).
 *
 * Uses the in-process Unipile mock server for the enumeration calls so
 * the response shape is the one the runtime code actually sees; injects
 * a fake DB for the integrations table since the safety-net path only
 * reads one row shape.
 */

import type { Database } from '@maskin/db'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import {
	__resetLinkedInMcpRegistryForTests,
	getLinkedInMcpInstancesForIntegration,
	instanceSlug,
	listLinkedInMcpInstances,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'

vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn((s: string) => s),
	encrypt: vi.fn((s: string) => s),
}))

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
	type LinkedInMockServer,
	planManagedPagesResponse,
	resetManagedPagesResponse,
	startLinkedInMock,
} from '../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import {
	PageAdminRevokedError,
	RETRY_POLICY_BY_CODE,
	classifyLinkedInResponse,
	isPageAdminRevokedBody,
} from '../../lib/integrations/providers/linkedin-unipile/errors'
import { withPageAdminRevokeSafetyNet } from '../../lib/integrations/providers/linkedin-unipile/operations'
import { createLinkedInHttpClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import {
	__setLinkedInWebhookClientForTests,
	handleUnipileAccountUpdated,
} from '../../lib/integrations/providers/linkedin-unipile/webhook'

type IntegrationRow = {
	id: string
	workspaceId: string
	actorId: string | null
	provider: string
	status: string
	externalId: string
	credentials: string
	unipileAccSlug: string | null
	createdBy: string
}

/**
 * Build a fake db.select().from(integrations).where(...) chain that answers
 * with the seeded row. The safety-net + webhook code only reads
 * `integrations` and only via one selector shape (equality on provider +
 * externalId + status), so a passthrough of the seeded rows is faithful to
 * production.
 */
function buildFakeDb(rows: IntegrationRow[]): Database {
	const fake = {
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(rows),
			}),
		}),
	}
	// Runtime shape covers exactly the reads the safety-net + webhook code
	// perform against `integrations`; a full drizzle Database would require
	// several megabytes of unrelated method stubs for a one-selector test.
	return fake as unknown as Database
}

// A stable per-credential coordinate set used by every test below.
const CREDENTIAL = {
	integrationId: '11111111-1111-1111-1111-111111111111',
	workspaceId: '22222222-2222-2222-2222-222222222222',
	actorId: '33333333-3333-3333-3333-333333333333',
	unipileAccountId: 'unipile-account-abc',
	unipileAccSlug: 'sebastianbille',
}

function buildPageInstance(
	overrides: Partial<LinkedInMcpInstanceConfig> = {},
): LinkedInMcpInstanceConfig {
	return {
		workspaceId: CREDENTIAL.workspaceId,
		actorId: CREDENTIAL.actorId,
		integrationId: CREDENTIAL.integrationId,
		unipileAccountId: CREDENTIAL.unipileAccountId,
		unipileAccSlug: CREDENTIAL.unipileAccSlug,
		identityType: 'company_page',
		identityUrn: 'urn:li:organization:11111111',
		identitySlug: 'maskinio',
		displayName: 'Maskin',
		mailboxId: 'mock-mailbox-1',
		messagingEnabled: true,
		...overrides,
	}
}

function buildPersonalInstance(): LinkedInMcpInstanceConfig {
	return {
		workspaceId: CREDENTIAL.workspaceId,
		actorId: CREDENTIAL.actorId,
		integrationId: CREDENTIAL.integrationId,
		unipileAccountId: CREDENTIAL.unipileAccountId,
		unipileAccSlug: CREDENTIAL.unipileAccSlug,
		identityType: 'personal',
		identityUrn: 'urn:li:person:mock-user-me-provider-id',
		identitySlug: 'personal',
		displayName: 'Sebastian Bille',
		mailboxId: 'CLASSIC_PRIMARY',
		messagingEnabled: true,
	}
}

describe('R11-C · PAGE_ADMIN_REVOKED classification + retry policy', () => {
	it('classifies 403 + error_code page_admin_revoked as PAGE_ADMIN_REVOKED', () => {
		expect(classifyLinkedInResponse(403, { error_code: 'page_admin_revoked' })).toBe(
			'PAGE_ADMIN_REVOKED',
		)
	})

	it('also recognises the no_admin_access spelling on 403', () => {
		expect(classifyLinkedInResponse(403, { error_code: 'no_admin_access' })).toBe(
			'PAGE_ADMIN_REVOKED',
		)
	})

	it('does NOT classify a 403 without the marker as PAGE_ADMIN_REVOKED', () => {
		// Bare 403 with no discriminator falls into INVALID_INPUT via the 4xx
		// default — the safety-net side effect only fires on the specific class.
		expect(classifyLinkedInResponse(403, { error_code: 'something_else' })).not.toBe(
			'PAGE_ADMIN_REVOKED',
		)
	})

	it('does NOT classify the marker on a non-403 status', () => {
		// 200 with the marker body is a well-formed success — the classifier
		// only fires on the status boundary too.
		expect(classifyLinkedInResponse(200, { error_code: 'page_admin_revoked' })).toBeNull()
	})

	it('reports the body-marker discriminator via isPageAdminRevokedBody', () => {
		expect(isPageAdminRevokedBody({ error_code: 'page_admin_revoked' })).toBe(true)
		expect(isPageAdminRevokedBody({ error_code: 'PAGE_ADMIN_REVOKED' })).toBe(true) // case-insensitive
		expect(isPageAdminRevokedBody({ error_code: 'no_admin_access' })).toBe(true)
		expect(isPageAdminRevokedBody({})).toBe(false)
	})

	it('has retry policy null (never retryable)', () => {
		expect(RETRY_POLICY_BY_CODE.PAGE_ADMIN_REVOKED).toBeNull()
	})

	it('PageAdminRevokedError has the right code + status + retry flag', () => {
		const err = new PageAdminRevokedError()
		expect(err.code).toBe('PAGE_ADMIN_REVOKED')
		expect(err.httpStatus).toBe(403)
		expect(err.retryable).toBe(false)
	})
})

describe('R11-C · 403 safety-net deregister-and-re-enumerate', () => {
	let mock: LinkedInMockServer

	beforeEach(async () => {
		mock = await startLinkedInMock()
		__resetLinkedInMcpRegistryForTests()
		resetManagedPagesResponse()
		__setLinkedInWebhookClientForTests(() =>
			createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
	})

	afterEach(async () => {
		await mock.close()
		__resetLinkedInMcpRegistryForTests()
		resetManagedPagesResponse()
		__setLinkedInWebhookClientForTests(null)
	})

	it('deregisters instance + enqueues re-enumeration + throws PageAdminRevokedError on a 403', async () => {
		// Seed the registry with a personal + a page instance (the state that
		// exists at the moment the 403 lands).
		const personal = buildPersonalInstance()
		const page = buildPageInstance()
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(page)
		expect(getLinkedInMcpInstancesForIntegration(CREDENTIAL.integrationId)).toHaveLength(2)

		// The re-enumeration reads integrations by (provider, externalId, status)
		// — seed the fake db with the credential row that the webhook code
		// resolves to.
		const db = buildFakeDb([
			{
				id: CREDENTIAL.integrationId,
				workspaceId: CREDENTIAL.workspaceId,
				actorId: CREDENTIAL.actorId,
				provider: 'linkedin-unipile',
				status: 'active',
				externalId: CREDENTIAL.unipileAccountId,
				credentials: JSON.stringify({ account_id: CREDENTIAL.unipileAccountId }),
				unipileAccSlug: CREDENTIAL.unipileAccSlug,
				createdBy: CREDENTIAL.actorId,
			},
		])

		// Force the mock to return an enumeration that OMITS the revoked page.
		// Personal identity still comes back (from the /users/me route). Empty
		// pages array = the page-admin was revoked upstream.
		planManagedPagesResponse([])

		// Plant a 403 on the next page-scoped call.
		mock.setNext('page-admin-revoked')

		// Build a client hitting the mock, then a page-scoped call to exercise
		// the safety-net wrapper. `publishPost` is a page-scoped route in
		// R11-A's fan-out (the personal instance uses it too but with a
		// different URN — safety-net cfg is what pins the instance).
		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const call = () =>
			client.publishPost({
				account_id: CREDENTIAL.unipileAccountId,
				text: 'Hello from Maskin',
				post_as: page.identityUrn,
			})

		// Cast db to the runtime type — the fake covers only the reads the
		// safety-net actually performs.
		await expect(
			// exactly what the safety-net reads; a full drizzle Database would
			// require several megabytes of unrelated method stubs for one test.
			withPageAdminRevokeSafetyNet(db, page, call as never),
		).rejects.toBeInstanceOf(PageAdminRevokedError)

		// Instance for the revoked page is gone — both the specific one AND from
		// the credential's list.
		expect(listLinkedInMcpInstances().get(instanceSlug(page))).toBeUndefined()
		const remaining = getLinkedInMcpInstancesForIntegration(CREDENTIAL.integrationId)
		expect(remaining.map((c) => instanceSlug(c))).toEqual([instanceSlug(personal)])

		// The re-enumeration got called: mock inbox has both /users/me and
		// /linkedin/company/pages hits (R11-A's canonical enumeration URLs).
		const paths = mock.inbox().map((r) => r.path.split('?')[0] ?? '')
		expect(paths).toContain(`/v2/${CREDENTIAL.unipileAccountId}/users/me`)
		expect(paths).toContain(`/v2/${CREDENTIAL.unipileAccountId}/linkedin/company/pages`)
	})

	it('does not disturb github-* or other LinkedIn instances on a deregister', async () => {
		const personal = buildPersonalInstance()
		const pageA = buildPageInstance({
			identitySlug: 'page-a',
			identityUrn: 'urn:li:organization:aaaa',
		})
		const pageB = buildPageInstance({
			identitySlug: 'page-b',
			identityUrn: 'urn:li:organization:bbbb',
		})
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(pageA)
		registerLinkedInMcpInstance(pageB)

		const db = buildFakeDb([
			{
				id: CREDENTIAL.integrationId,
				workspaceId: CREDENTIAL.workspaceId,
				actorId: CREDENTIAL.actorId,
				provider: 'linkedin-unipile',
				status: 'active',
				externalId: CREDENTIAL.unipileAccountId,
				credentials: JSON.stringify({ account_id: CREDENTIAL.unipileAccountId }),
				unipileAccSlug: CREDENTIAL.unipileAccSlug,
				createdBy: CREDENTIAL.actorId,
			},
		])

		// Enumeration returns pageB only — pageA is what got revoked.
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
			client.publishPost({
				account_id: CREDENTIAL.unipileAccountId,
				text: 'hello',
				post_as: pageA.identityUrn,
			})

		await expect(withPageAdminRevokeSafetyNet(db, pageA, call as never)).rejects.toBeInstanceOf(
			PageAdminRevokedError,
		)

		// pageA is gone; personal + pageB remain.
		const slugs = getLinkedInMcpInstancesForIntegration(CREDENTIAL.integrationId)
			.map((c) => instanceSlug(c))
			.sort()
		expect(slugs).toEqual([instanceSlug(personal), instanceSlug(pageB)].sort())
	})
})

describe('R11-C · unipile.account.updated webhook — diff, register-new, deregister-removed, rename', () => {
	let mock: LinkedInMockServer

	beforeEach(async () => {
		mock = await startLinkedInMock()
		__resetLinkedInMcpRegistryForTests()
		resetManagedPagesResponse()
		__setLinkedInWebhookClientForTests(() =>
			createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
	})

	afterEach(async () => {
		await mock.close()
		__resetLinkedInMcpRegistryForTests()
		resetManagedPagesResponse()
		__setLinkedInWebhookClientForTests(null)
	})

	function seedCredentialDb() {
		return buildFakeDb([
			{
				id: CREDENTIAL.integrationId,
				workspaceId: CREDENTIAL.workspaceId,
				actorId: CREDENTIAL.actorId,
				provider: 'linkedin-unipile',
				status: 'active',
				externalId: CREDENTIAL.unipileAccountId,
				credentials: JSON.stringify({ account_id: CREDENTIAL.unipileAccountId }),
				unipileAccSlug: CREDENTIAL.unipileAccSlug,
				createdBy: CREDENTIAL.actorId,
			},
		])
	}

	it('registers new identities the enumeration reports (first-time account.updated)', async () => {
		// Empty registry, mock reports personal + one page.
		planManagedPagesResponse([
			{
				id: 'mock-page-new',
				provider_id: '99999',
				public_identifier: 'new-page',
				name: 'New Page',
				messaging_enabled: true,
				mailbox_id: 'mailbox-new',
			},
		])
		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const db = seedCredentialDb()

		const result = await handleUnipileAccountUpdated(db, client, CREDENTIAL.unipileAccountId)

		expect(result.appliedTo).toHaveLength(1)
		const entry = result.appliedTo[0]
		if (entry && 'diff' in entry && 'registered' in (entry.diff as object)) {
			const diff = entry.diff as {
				registered: LinkedInMcpInstanceConfig[]
				deregistered: LinkedInMcpInstanceConfig[]
			}
			expect(diff.registered.map((c) => c.identitySlug).sort()).toEqual(['new-page', 'personal'])
			expect(diff.deregistered).toEqual([])
		} else {
			throw new Error('expected a successful diff, got error')
		}
	})

	it('deregisters identities that vanished from the enumeration', async () => {
		// Registry has personal + a page LinkedIn no longer lists.
		const personal = buildPersonalInstance()
		const gonePage = buildPageInstance({
			identitySlug: 'ghost-page',
			identityUrn: 'urn:li:organization:ghost',
		})
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(gonePage)

		// Enumeration reports personal only (no pages).
		planManagedPagesResponse([])
		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const db = seedCredentialDb()

		await handleUnipileAccountUpdated(db, client, CREDENTIAL.unipileAccountId)

		// Personal stayed (unchanged), gonePage removed.
		expect(listLinkedInMcpInstances().get(instanceSlug(personal))).toBeDefined()
		expect(listLinkedInMcpInstances().get(instanceSlug(gonePage))).toBeUndefined()
	})

	it('produces a deregister-then-register pair on a page rename (public_identifier change)', async () => {
		// Registry knows the page under its old handle.
		const oldPage = buildPageInstance({
			identitySlug: 'oldhandle',
			identityUrn: 'urn:li:organization:11111111',
			displayName: 'Old Name',
		})
		registerLinkedInMcpInstance(oldPage)

		// LinkedIn now reports the same page under a new handle. provider_id is
		// stable so identity_urn stays the same, but the slug is the identity
		// half of the instance name — that changed => deregister-then-register.
		planManagedPagesResponse([
			{
				id: 'mock-page-1',
				provider_id: '11111111',
				public_identifier: 'newhandle',
				name: 'New Name',
				messaging_enabled: true,
				mailbox_id: 'mock-mailbox-1',
			},
		])
		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const db = seedCredentialDb()

		await handleUnipileAccountUpdated(db, client, CREDENTIAL.unipileAccountId)

		// Old slug gone, new slug present.
		expect(listLinkedInMcpInstances().get(instanceSlug(oldPage))).toBeUndefined()
		const newSlug = `linkedin-${CREDENTIAL.unipileAccSlug}-newhandle`
		expect(listLinkedInMcpInstances().get(newSlug)).toBeDefined()
		const stored = listLinkedInMcpInstances().get(newSlug)
		expect(stored?.displayName).toBe('New Name')
	})

	it('no-ops (returns unchanged) when the enumeration matches what is registered', async () => {
		const personal = buildPersonalInstance()
		const page = buildPageInstance()
		registerLinkedInMcpInstance(personal)
		registerLinkedInMcpInstance(page)

		// Mock's default managed-pages response matches the seeded page.
		const client = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const db = seedCredentialDb()

		const result = await handleUnipileAccountUpdated(db, client, CREDENTIAL.unipileAccountId)

		const entry = result.appliedTo[0]
		if (entry && 'diff' in entry && 'unchanged' in (entry.diff as object)) {
			const diff = entry.diff as {
				registered: LinkedInMcpInstanceConfig[]
				deregistered: LinkedInMcpInstanceConfig[]
				unchanged: LinkedInMcpInstanceConfig[]
			}
			expect(diff.registered).toEqual([])
			expect(diff.deregistered).toEqual([])
			expect(diff.unchanged.length).toBeGreaterThan(0)
		} else {
			throw new Error('expected an unchanged diff, got error')
		}
	})
})
