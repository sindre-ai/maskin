import type { Database } from '@maskin/db'
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
	CONNECTION_REQUEST_TRIGGERS,
	type UnipileMockServer,
	startUnipileMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { LinkedInIntegrationError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'
import {
	__setUnipileClientForTests,
	sendLinkedInConnectionRequest,
} from '../../../../../lib/integrations/providers/linkedin-unipile/operations'
import type {
	UnipileClient,
	UnipileConnectionRequestPayload,
} from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { createUnipileHttpClient } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * Coverage from the acceptance list (Task 7a):
 *   - happy path (returns { status: 'sent', sent_at })
 *   - LINKEDIN_INVITE_QUOTA_EXCEEDED path
 *   - LINKEDIN_ALREADY_CONNECTED path
 *   - CREDENTIAL_NOT_CONNECTED path (integrations lookup returned null)
 *   - one round-trip integration test through the reshaped mock server
 *
 * The operation-level suite stubs `UnipileClient` directly to keep the tests
 * quick and deterministic; the integration suite spins up the mock HTTP
 * server so the client + normalizer + classifier are all exercised through
 * real fetch calls against the shape production will actually hit.
 */

const ctx = { db: {} as Database, actorId: 'actor-1', workspaceId: 'ws-1' }

type Recorded = { name: string; args: unknown }

function stubClient(
	response: unknown,
	status = 200,
): { calls: Recorded[]; last: () => UnipileConnectionRequestPayload | undefined } {
	const calls: Recorded[] = []
	__setUnipileClientForTests(() => {
		const record =
			(name: string) =>
			async (args: unknown): Promise<{ status: number; body: unknown; headers: Record<string, string> }> => {
				calls.push({ name, args })
				return { status, body: response, headers: {} }
			}
		return {
			sendMessage: record('sendMessage'),
			reply: record('reply'),
			listConversations: record('listConversations'),
			listMessages: record('listMessages'),
			listRelations: record('listRelations'),
			searchPeople: record('searchPeople'),
			getProfile: record('getProfile'),
			sendConnectionRequest: record('sendConnectionRequest'),
		} as unknown as UnipileClient
	})
	return {
		calls,
		last: () => {
			const call = calls.at(-1)
			return call?.name === 'sendConnectionRequest'
				? (call.args as UnipileConnectionRequestPayload)
				: undefined
		},
	}
}

beforeEach(() => {
	credentialMock.mockResolvedValue({
		id: 'int-1',
		actorId: 'actor-1',
		credentials: 'encrypted',
	})
})

afterEach(() => {
	__setUnipileClientForTests(null)
	vi.restoreAllMocks()
})

describe('sendLinkedInConnectionRequest — happy path', () => {
	it('returns a normalised { status, sent_at, invitation_id } envelope on a 200', async () => {
		stubClient({
			object: 'UserInvitationSent',
			invitation_id: 'inv-42',
			sent_at: '2026-09-07T10:00:00.000Z',
		})
		const res = await sendLinkedInConnectionRequest(ctx, {
			user_id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx',
			message: 'Nice to meet you.',
		})
		expect(res).toEqual({
			status: 'sent',
			sent_at: '2026-09-07T10:00:00.000Z',
			invitation_id: 'inv-42',
		})
	})

	it('synthesises sent_at when Unipile omits it, and passes user_id + message to the client verbatim', async () => {
		const { last } = stubClient({ object: 'UserInvitationSent', invitation_id: 'inv-43' })
		const before = Date.now()
		const res = await sendLinkedInConnectionRequest(ctx, {
			user_id: '  user-42  ',
			message: 'hello there',
		})
		const after = Date.now()
		// A missing sent_at collapses to server-now rather than an empty
		// string — an agent using it to sort/dedup outreach must not see NaN.
		expect(Date.parse(res.sent_at)).toBeGreaterThanOrEqual(before)
		expect(Date.parse(res.sent_at)).toBeLessThanOrEqual(after)
		expect(last()).toEqual({
			account_id: 'acc_1',
			user_id: 'user-42', // trimmed
			message: 'hello there',
		})
	})

	it('omits `message` on the wire when the caller did not supply one', async () => {
		const { last } = stubClient({ object: 'UserInvitationSent', invitation_id: 'inv-44' })
		await sendLinkedInConnectionRequest(ctx, {
			user_id: 'user-44',
		})
		// A null-vs-absent distinction matters on some tenants — sending
		// { message: null } gets a bare invite rejected by Unipile whereas
		// omitting the key gets the normal path. Absence means absence.
		expect(last()?.message).toBeUndefined()
	})

	it('treats an all-whitespace message as absent (no bare-note invite)', async () => {
		const { last } = stubClient({ object: 'UserInvitationSent' })
		await sendLinkedInConnectionRequest(ctx, {
			user_id: 'user-45',
			message: '   \n\t   ',
		})
		expect(last()?.message).toBeUndefined()
	})
})

describe('sendLinkedInConnectionRequest — error paths', () => {
	it('surfaces LINKEDIN_INVITE_QUOTA_EXCEEDED from the wire envelope', async () => {
		stubClient({ error_code: 'invite_quota_exceeded', message: 'weekly limit reached' }, 400)
		await expect(
			sendLinkedInConnectionRequest(ctx, { user_id: 'user-46' }),
		).rejects.toMatchObject({
			code: 'LINKEDIN_INVITE_QUOTA_EXCEEDED',
			retryable: false,
		})
	})

	it('surfaces LINKEDIN_ALREADY_CONNECTED from the wire envelope', async () => {
		stubClient({ error_code: 'already_connected', message: 'already invited' }, 409)
		await expect(
			sendLinkedInConnectionRequest(ctx, { user_id: 'user-47' }),
		).rejects.toMatchObject({
			code: 'LINKEDIN_ALREADY_CONNECTED',
			retryable: false,
		})
	})

	it('surfaces CREDENTIAL_NOT_CONNECTED when the workspace has no connected identity', async () => {
		// No integrations row — the preamble short-circuits before any
		// Unipile call happens.
		credentialMock.mockResolvedValue(null)
		const { calls } = stubClient({}, 200)
		await expect(
			sendLinkedInConnectionRequest(ctx, { user_id: 'user-48' }),
		).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONNECTED' })
		expect(calls).toHaveLength(0)
	})

	it('rejects a missing user_id without hitting Unipile', async () => {
		const { calls } = stubClient({}, 200)
		await expect(sendLinkedInConnectionRequest(ctx, {})).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		})
		expect(calls).toHaveLength(0)
	})

	it('rejects an empty-string user_id without hitting Unipile', async () => {
		const { calls } = stubClient({}, 200)
		await expect(
			sendLinkedInConnectionRequest(ctx, { user_id: '   ' }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(calls).toHaveLength(0)
	})
})

// Integration: no client stub, real fetch against the in-process mock. The
// mock's `CONNECTION_REQUEST_TRIGGERS` let a specific user_id force the wire
// error envelope, so the classifier is exercised end-to-end through the same
// path the production route walks.
describe('sendLinkedInConnectionRequest — integration through the mock server', () => {
	const ORIGINAL_ENV: Record<string, string | undefined> = {}
	const ENV_KEYS = ['UNIPILE_BASE_URL', 'UNIPILE_API_KEY'] as const
	let mock: UnipileMockServer

	beforeAll(async () => {
		for (const key of ENV_KEYS) ORIGINAL_ENV[key] = process.env[key]
		mock = await startUnipileMock()
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
		// Route through the real HTTP client — no injected stub.
		__setUnipileClientForTests(null)
	})

	it('POSTs to /v2/{account_id}/users/me/relation-requests with the documented body', async () => {
		const res = await sendLinkedInConnectionRequest(ctx, {
			user_id: 'user-mock-happy',
			message: 'Enjoyed your Rust workshop.',
		})
		expect(res.status).toBe('sent')
		expect(res.invitation_id).toMatch(/^mock-invite-/)
		const call = mock.inbox().find((c) => c.path.endsWith('/users/me/relation-requests'))
		expect(call?.method).toBe('POST')
		expect(call?.path).toBe('/v2/acc_1/users/me/relation-requests')
		expect(call?.body).toEqual({
			user_id: 'user-mock-happy',
			message: 'Enjoyed your Rust workshop.',
		})
	})

	it('classifies the invite-quota-exceeded envelope end-to-end', async () => {
		await expect(
			sendLinkedInConnectionRequest(ctx, {
				user_id: CONNECTION_REQUEST_TRIGGERS.inviteQuotaExceeded,
			}),
		).rejects.toMatchObject({
			code: 'LINKEDIN_INVITE_QUOTA_EXCEEDED',
			retryable: false,
		})
	})

	it('classifies the already-connected envelope end-to-end', async () => {
		await expect(
			sendLinkedInConnectionRequest(ctx, {
				user_id: CONNECTION_REQUEST_TRIGGERS.alreadyConnected,
			}),
		).rejects.toMatchObject({
			code: 'LINKEDIN_ALREADY_CONNECTED',
			retryable: false,
		})
	})
})

// Belt-and-braces on the mock: the connect-request route lives at
// `/users/me/relation-requests`, which the generic `/users/:identifier` route
// also matches with identifier="me" as a prefix. This is the same collision
// family that made `/users/relations` silently succeed against the wrong
// endpoint on the live API — pin the ordering so a future edit to the mock
// cannot regress into it.
describe('mock server route ordering — relation-requests wins over /users/:identifier', () => {
	let mock: UnipileMockServer
	beforeAll(async () => {
		mock = await startUnipileMock()
	})
	afterAll(async () => {
		await mock.close()
	})

	it('routes POST /v2/acc/users/me/relation-requests to the connect-request handler', async () => {
		const res = await fetch(`${mock.baseUrl}/v2/acc/users/me/relation-requests`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ user_id: 'x' }),
		})
		const body = (await res.json()) as { object?: string }
		expect(res.status).toBe(200)
		expect(body.object).toBe('UserInvitationSent')
	})

	it('exposes CONNECTION_REQUEST_TRIGGERS with the documented wire discriminators', () => {
		// Belt: the tests above use the constants; braces: catch a typo edit
		// to the mock that would let a happy-path stub through by accident.
		expect(CONNECTION_REQUEST_TRIGGERS.inviteQuotaExceeded).toBe(
			'mock-trigger-invite-quota-exceeded',
		)
		expect(CONNECTION_REQUEST_TRIGGERS.alreadyConnected).toBe('mock-trigger-already-connected')
	})

	it('exports the operation seam so a caller can spot a rename before the wire', () => {
		// The named export is the contract with the MCP tool + route.
		expect(typeof sendLinkedInConnectionRequest).toBe('function')
	})
})

// A tiny smoke that the HTTP client's new method actually hits the right
// path on its own — mirrors read-tools' pinning of routes so a wrong
// endpoint can't ship green.
describe('createUnipileHttpClient.sendConnectionRequest — pinned route', () => {
	let mock: UnipileMockServer
	beforeAll(async () => {
		mock = await startUnipileMock()
	})
	afterAll(async () => {
		await mock.close()
	})
	it('POSTs /v2/{account}/users/me/relation-requests with { user_id, message }', async () => {
		const client = createUnipileHttpClient({ baseUrl: mock.baseUrl, apiKey: 'k' })
		const res = await client.sendConnectionRequest({
			account_id: 'acc',
			user_id: 'u',
			message: 'hi',
		})
		expect(res.status).toBe(200)
		const call = mock.inbox().at(-1)
		expect(call?.method).toBe('POST')
		expect(call?.path).toBe('/v2/acc/users/me/relation-requests')
		expect(call?.body).toEqual({ user_id: 'u', message: 'hi' })
	})
	it('omits the message key when the caller did not pass one', async () => {
		const client = createUnipileHttpClient({ baseUrl: mock.baseUrl, apiKey: 'k' })
		await client.sendConnectionRequest({ account_id: 'acc', user_id: 'u' })
		const call = mock.inbox().at(-1)
		expect(call?.body).toEqual({ user_id: 'u' })
	})
})

// Belt on the LinkedInIntegrationError shape for the two new codes so the
// route mapping (which reads err.httpStatus) doesn't drift silently.
describe('LinkedInIntegrationError HTTP status mapping — connect-request codes', () => {
	it('LINKEDIN_INVITE_QUOTA_EXCEEDED defaults to HTTP 403', () => {
		const err = new LinkedInIntegrationError('LINKEDIN_INVITE_QUOTA_EXCEEDED', 'x')
		expect(err.httpStatus).toBe(403)
	})
	it('LINKEDIN_ALREADY_CONNECTED defaults to HTTP 409', () => {
		const err = new LinkedInIntegrationError('LINKEDIN_ALREADY_CONNECTED', 'x')
		expect(err.httpStatus).toBe(409)
	})
})
