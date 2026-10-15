import type { Database } from '@maskin/db'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import { toolName } from '@maskin/mcp/linkedin'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { credentialMock } = vi.hoisted(() => ({ credentialMock: vi.fn() }))
vi.mock('../../../../../lib/integrations/lookup', () => ({
	actorScopedProviders: new Set(['linkedin-unipile']),
	getIntegrationCredential: credentialMock,
}))
vi.mock('../../../../../lib/workspace-auth', () => ({ isWorkspaceMember: async () => true }))
vi.mock('../../../../../lib/crypto', () => ({
	decrypt: () => JSON.stringify({ account_id: 'acc_1' }),
	encrypt: (v: string) => v,
}))

import {
	type LinkedInMockServer,
	startLinkedInMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { createLinkedInMcpServer } from '../../../../../lib/integrations/providers/linkedin-unipile/mcp-server'

/**
 * The get_profile acceptance shapes, driven at the MCP tool boundary — the
 * exact layer the agent calls.
 *
 * The two unit suites next to this one pin the shapes at the client wire
 * (client.test.ts) and at the operations mapping (read-tools.test.ts). This
 * one runs the fan-out tool's OWN handler, through the operations layer, out
 * to a real HTTP client against the recording mock — so a regression that
 * fixes the wire but drops it before the tool result (or vice versa) flips
 * red HERE. It is the closest in-process stand-in for the live MCP call,
 * which cannot be exercised in a sandbox where the dev API's warm-image step
 * needs a Docker socket.
 *
 * Fixture is a personal identity whose credential row is the one the mocked
 * preamble resolves; the identifier under test is a fsd_profile URN, the
 * exact value a prior search_people / list_connections surfaced.
 */

const ORIGINAL_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['UNIPILE_BASE_URL', 'UNIPILE_API_KEY'] as const

let mock: LinkedInMockServer

const personal: LinkedInMcpInstanceConfig = {
	workspaceId: 'ws-1',
	actorId: 'sebastian',
	integrationId: 'int-1',
	unipileAccountId: 'acc_1',
	unipileAccSlug: 'sebastianbille',
	identityType: 'personal',
	identityUrn: 'urn:li:person:seb',
	identitySlug: 'personal',
	displayName: 'Sebastian Bille',
	mailboxId: null,
	messagingEnabled: true,
}

// The fan-out preamble reads the identity's own integrations row unfiltered by
// status; the mock credential resolver cannot stand in for that query, so the
// test supplies the single active row it would find.
function fakeDb(): Database {
	return {
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ id: 'int-1', status: 'active' }] }),
			}),
		}),
	} as unknown as Database
}

function getProfileHandler() {
	const server = createLinkedInMcpServer(
		{ db: fakeDb(), actorId: 'sebastian', workspaceId: 'ws-1' },
		[personal],
	)
	const registered = (
		server as unknown as {
			_registeredTools: Record<
				string,
				{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
			>
		}
	)._registeredTools
	const entry = registered[toolName(personal, 'get_profile')]
	expect(entry).toBeDefined()
	return entry
}

async function callGetProfile(identifier: string) {
	const result = (await getProfileHandler().handler({ identifier }, {})) as {
		isError?: boolean
		content: Array<{ text: string }>
	}
	return result
}

beforeAll(async () => {
	for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
	mock = await startLinkedInMock()
})

afterAll(async () => {
	await mock.close()
	for (const key of ENV_KEYS) {
		if (ORIGINAL_ENV[key] === undefined) delete process.env[key]
		else process.env[key] = ORIGINAL_ENV[key]
	}
})

beforeEach(() => {
	mock.resetInbox()
	process.env.UNIPILE_BASE_URL = mock.baseUrl
	process.env.UNIPILE_API_KEY = 'test-api-key'
	credentialMock.mockResolvedValue({
		id: 'int-1',
		actorId: 'sebastian',
		status: 'active',
		credentials: 'encrypted',
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('get_profile tool boundary', () => {
	it('resolves a fsd_profile URN end-to-end and returns network_distance', async () => {
		const res = await callGetProfile('urn:li:fsd_profile:mock-user-2')
		expect(res.isError).toBeFalsy()

		const person = JSON.parse(res.content[0].text)
		// Shape 1: the URN reduces to the bare provider id and the call
		// succeeds, rather than faulting INVALID_INPUT as it did live.
		expect(person.recipient_urn).toBe('mock-user-2')
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/users/mock-user-2')
		// Shape 2: network_distance rides the v2 `specifics` block, so a
		// successful path no longer fail-closes the DNC rule on ''.
		expect(person.network_distance).toBe('SECOND_DEGREE')
	})

	it('resolves a person URN and a bare handle the same way', async () => {
		await callGetProfile('urn:li:person:mock-user-2')
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/users/mock-user-2')

		await callGetProfile('gracehopper')
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/users/gracehopper')
	})
})
