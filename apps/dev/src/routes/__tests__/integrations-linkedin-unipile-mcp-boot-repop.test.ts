import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Boot repopulation + self-heal on demand — acceptance criteria 1 and 3
 * from the [Fix] LinkedIn Unipile MCP registry task.
 *
 * Mocks `enumerateLinkedInIdentitiesAndRegister` directly rather than
 * driving the real function against the Unipile mock server: the boot /
 * self-heal contract this test proves is about how the DB → registry
 * wiring behaves (which credentials get enumerated, what happens on
 * failure, that the negative cache short-circuits the second attempt),
 * not about the wire-level shape of a Unipile page-list — which is what
 * the R11-A fan-out suite pins.
 *
 * Deliberately does not exercise the streamable-HTTP transport itself —
 * self-heal is a predicate on the registry BEFORE the server is built,
 * and testing the transport again would re-cover ground the fan-out
 * suite already pins.
 */

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/integrations/providers/linkedin-unipile/enumeration', () => ({
	enumerateLinkedInIdentitiesAndRegister: vi.fn(),
}))

import type { Database } from '@maskin/db'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import {
	__resetLinkedInMcpRegistryForTests,
	getLinkedInMcpInstancesForIntegration,
	listLinkedInMcpInstances,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { repopulateLinkedInMcpRegistryOnBoot } from '../../lib/integrations/providers/linkedin-unipile/boot-repopulation'
import { enumerateLinkedInIdentitiesAndRegister } from '../../lib/integrations/providers/linkedin-unipile/enumeration'
import {
	__resetLinkedInMcpSelfHealForTests,
	selfHealLinkedInMcpCredential,
} from '../../lib/integrations/providers/linkedin-unipile/mcp-registry-self-heal'

const mockedEnumerate = vi.mocked(enumerateLinkedInIdentitiesAndRegister)

type IntegrationRow = {
	id: string
	workspaceId: string
	actorId: string | null
	provider: string
	status: string
	externalId: string | null
	createdBy: string
}

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'

function row(id: string, overrides: Partial<IntegrationRow> = {}): IntegrationRow {
	return {
		id,
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		provider: 'linkedin-unipile',
		status: 'active',
		externalId: `unipile-${id}`,
		createdBy: ACTOR_ID,
		...overrides,
	}
}

/**
 * Fake DB whose `select().from(integrations).where(...)` chain returns the
 * seeded rows. The boot repopulation path only reads `integrations` and
 * only via one selector shape (equality on provider + status + not-null
 * external_id), so a passthrough is faithful to production.
 */
function fakeDb(rows: IntegrationRow[]): Database {
	const fake = {
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(rows),
			}),
		}),
	}
	return fake as unknown as Database
}

/**
 * Register one fake personal + one fake page instance under this
 * integration and return the shape the production `enumerationResult`
 * carries so the wiring under test sees a plausible payload.
 */
function fakeRegister(integrationId: string): {
	unipileAccSlug: string
	instances: LinkedInMcpInstanceConfig[]
} {
	const personal: LinkedInMcpInstanceConfig = {
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		integrationId,
		unipileAccountId: `unipile-${integrationId}`,
		unipileAccSlug: 'test-acc',
		identityType: 'personal',
		identityUrn: `urn:li:person:${integrationId}`,
		identitySlug: 'personal',
		displayName: 'Test User',
		mailboxId: 'CLASSIC_PRIMARY',
		messagingEnabled: true,
	}
	const page: LinkedInMcpInstanceConfig = {
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		integrationId,
		unipileAccountId: `unipile-${integrationId}`,
		unipileAccSlug: 'test-acc',
		identityType: 'company_page',
		identityUrn: 'urn:li:organization:11111111',
		identitySlug: 'maskinio',
		displayName: 'Maskin',
		mailboxId: 'mock-mailbox-1',
		messagingEnabled: true,
	}
	registerLinkedInMcpInstance(personal)
	registerLinkedInMcpInstance(page)
	return { unipileAccSlug: 'test-acc', instances: [personal, page] }
}

describe('linkedin-unipile MCP registry — boot repopulation (AC 1, 2)', () => {
	beforeEach(() => {
		__resetLinkedInMcpRegistryForTests()
		__resetLinkedInMcpSelfHealForTests()
		mockedEnumerate.mockReset()
	})

	afterEach(() => {
		__resetLinkedInMcpRegistryForTests()
		__resetLinkedInMcpSelfHealForTests()
		mockedEnumerate.mockReset()
	})

	it('AC1 — every active credential in the DB has its fan-out instances registered after boot repopulation, with no user action', async () => {
		mockedEnumerate.mockImplementation(async ({ integrationId }) => fakeRegister(integrationId))

		await repopulateLinkedInMcpRegistryOnBoot(fakeDb([row('cred-a'), row('cred-b')]))

		expect(mockedEnumerate).toHaveBeenCalledTimes(2)
		expect(
			getLinkedInMcpInstancesForIntegration('cred-a')
				.map((c) => c.identitySlug)
				.sort(),
		).toEqual(['maskinio', 'personal'])
		expect(
			getLinkedInMcpInstancesForIntegration('cred-b')
				.map((c) => c.identitySlug)
				.sort(),
		).toEqual(['maskinio', 'personal'])
	})

	it('AC2 — a Unipile failure on one credential logs a warning and leaves the others registered', async () => {
		mockedEnumerate.mockImplementation(async ({ integrationId }) => {
			if (integrationId === 'cred-broken') {
				throw new Error('unipile is down')
			}
			return fakeRegister(integrationId)
		})

		await repopulateLinkedInMcpRegistryOnBoot(fakeDb([row('cred-broken'), row('cred-healthy')]))

		expect(mockedEnumerate).toHaveBeenCalledTimes(2)
		expect(getLinkedInMcpInstancesForIntegration('cred-broken')).toEqual([])
		expect(
			getLinkedInMcpInstancesForIntegration('cred-healthy')
				.map((c) => c.identitySlug)
				.sort(),
		).toEqual(['maskinio', 'personal'])
	})
})

describe('linkedin-unipile MCP registry — self-heal on demand (AC 3)', () => {
	beforeEach(() => {
		__resetLinkedInMcpRegistryForTests()
		__resetLinkedInMcpSelfHealForTests()
		mockedEnumerate.mockReset()
	})

	afterEach(() => {
		__resetLinkedInMcpRegistryForTests()
		__resetLinkedInMcpSelfHealForTests()
		mockedEnumerate.mockReset()
	})

	it('AC3a — the next request after the registry is cleared repopulates it', async () => {
		mockedEnumerate.mockImplementation(async ({ integrationId }) => fakeRegister(integrationId))

		await repopulateLinkedInMcpRegistryOnBoot(fakeDb([row('cred-a')]))
		expect(listLinkedInMcpInstances().size).toBeGreaterThan(0)

		// Simulate a Coolify restart mid-runtime: the process-local Map is
		// gone but the DB row is still live.
		__resetLinkedInMcpRegistryForTests()
		__resetLinkedInMcpSelfHealForTests()
		expect(listLinkedInMcpInstances().size).toBe(0)
		mockedEnumerate.mockClear()

		// A `/mcp` request calling into self-heal with the same row fills the
		// registry inline before the server is built.
		await selfHealLinkedInMcpCredential(row('cred-a'))
		expect(mockedEnumerate).toHaveBeenCalledTimes(1)
		expect(
			getLinkedInMcpInstancesForIntegration('cred-a')
				.map((c) => c.identitySlug)
				.sort(),
		).toEqual(['maskinio', 'personal'])
	})

	it('AC3b — a second request in the negative-cache window does not call Unipile again', async () => {
		mockedEnumerate.mockRejectedValueOnce(new Error('unipile is down'))
		await selfHealLinkedInMcpCredential(row('cred-broken'))
		expect(mockedEnumerate).toHaveBeenCalledTimes(1)
		expect(getLinkedInMcpInstancesForIntegration('cred-broken')).toEqual([])

		// Even with the environment restored to a working state, the second
		// self-heal inside the negative-cache window is a noop — the failure
		// timestamp shortcuts the enumeration. Assert `enumerate` was NOT
		// called again.
		mockedEnumerate.mockClear()
		mockedEnumerate.mockImplementation(async ({ integrationId }) => fakeRegister(integrationId))
		await selfHealLinkedInMcpCredential(row('cred-broken'))
		expect(mockedEnumerate).not.toHaveBeenCalled()
		expect(getLinkedInMcpInstancesForIntegration('cred-broken')).toEqual([])
	})

	it('AC3c — a successful self-heal after the failure window clears the negative cache', async () => {
		mockedEnumerate.mockRejectedValueOnce(new Error('unipile is down'))
		await selfHealLinkedInMcpCredential(row('cred-recover'))
		expect(getLinkedInMcpInstancesForIntegration('cred-recover')).toEqual([])

		// Flushing the self-heal state models the negative-cache window
		// elapsing without a real timer wait.
		__resetLinkedInMcpSelfHealForTests()
		mockedEnumerate.mockClear()
		mockedEnumerate.mockImplementation(async ({ integrationId }) => fakeRegister(integrationId))

		await selfHealLinkedInMcpCredential(row('cred-recover'))
		expect(mockedEnumerate).toHaveBeenCalledTimes(1)
		expect(
			getLinkedInMcpInstancesForIntegration('cred-recover')
				.map((c) => c.identitySlug)
				.sort(),
		).toEqual(['maskinio', 'personal'])
	})

	it('AC3d — concurrent self-heal calls for the same credential dedupe to one enumeration', async () => {
		let resolveEnum: (() => void) | undefined
		const enumerationGate = new Promise<void>((resolve) => {
			resolveEnum = resolve
		})
		mockedEnumerate.mockImplementation(async ({ integrationId }) => {
			await enumerationGate
			return fakeRegister(integrationId)
		})

		const first = selfHealLinkedInMcpCredential(row('cred-a'))
		const second = selfHealLinkedInMcpCredential(row('cred-a'))
		resolveEnum?.()
		await Promise.all([first, second])
		expect(mockedEnumerate).toHaveBeenCalledTimes(1)
	})
})
