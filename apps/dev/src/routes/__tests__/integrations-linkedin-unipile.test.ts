import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Route-level tests for the LinkedIn (Unipile-backed) HTTP routes.
 *
 * These tests import the route module which itself depends on
 * `../../lib/integrations/lookup.ts` (introduced by Task 1's PR #1466). When
 * Task 1's PR is not yet merged to `main`, this test file will fail to
 * load on `main` — which is expected per the PR's stacked-dependency
 * disclosure. Once Task 1 lands, the test file resolves and the suite
 * verifies:
 *
 *   1. All six error classes from spec §4 surface with the correct code.
 *   2. Idempotency dedup — a second call with the same key does NOT re-hit
 *      Unipile and returns `replayed: true`.
 *   3. Two-actor lookup isolation — an actor A's send is routed to actor
 *      A's Unipile account_id, never actor B's, even in the same workspace.
 *
 * The test setup mocks the credential lookup, workspace-membership check,
 * and decrypt helpers so no real database or crypto material is exercised.
 * A fake Unipile client is injected via the route's test-only setter.
 */

// vi.mock is hoisted to the top of the file — do not move.
vi.mock('../../lib/integrations/lookup', () => ({
	actorScopedProviders: new Set(['linkedin-unipile']),
	getIntegrationCredential: vi.fn(),
}))

// Swap `delay` for a resolved-immediately promise so the RETRY_POLICY-driven
// backoff tests don't spend 6-9 seconds actually sleeping — the retry-count
// assertions verify the loop ran the right number of times regardless.
vi.mock('../../lib/integrations/providers/linkedin-unipile/errors', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/linkedin-unipile/errors')
	>('../../lib/integrations/providers/linkedin-unipile/errors')
	return { ...actual, delay: () => Promise.resolve() }
})

vi.mock('../../lib/crypto', () => ({
	decrypt: (s: string) => s,
	encrypt: (s: string) => s,
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { decrypt } from '../../lib/crypto'
import { getIntegrationCredential } from '../../lib/integrations/lookup'
import { isWorkspaceMember } from '../../lib/workspace-auth'
import integrationsLinkedinUnipileRoutes, {
	__setUnipileClientForTests,
} from '../integrations-linkedin-unipile'

type FakeDb = {
	select: ReturnType<typeof vi.fn>
	insert: ReturnType<typeof vi.fn>
	update: ReturnType<typeof vi.fn>
	delete: ReturnType<typeof vi.fn>
}

type IdempotencyRow = {
	key: string
	actorId: string | null
	method: string
	path: string
	status: number
	response: unknown
}

/**
 * Build a fake DB with an in-memory idempotency_records table. The select()
 * side ignores the opaque drizzle predicate and returns whatever is in the
 * store — every idempotency-tracked test uses a single unique key per
 * verb-path, so at most one row can match. Insert enforces PK uniqueness
 * (code '23505') to exercise the race-collapse fallback path.
 */
function buildFakeDb(initial: IdempotencyRow[] = []): FakeDb {
	const rows: IdempotencyRow[] = [...initial]
	return {
		select: vi.fn(() => ({
			from: () => ({
				where: (_predicate: unknown) => ({
					limit: (_n: number) => Promise.resolve(rows.length > 0 ? [rows[0]] : []),
				}),
			}),
		})),
		insert: vi.fn(() => ({
			values: (row: IdempotencyRow) => {
				if (rows.some((r) => r.key === row.key)) {
					const err = new Error('duplicate key value violates unique constraint')
					;(err as Error & { code: string }).code = '23505'
					throw err
				}
				rows.push(row)
				return Promise.resolve()
			},
		})),
		update: vi.fn(() => ({
			set: () => ({
				where: () => Promise.resolve(),
			}),
		})),
		delete: vi.fn(() => ({
			where: () => ({ returning: () => Promise.resolve([]) }),
		})),
	}
}

function buildAppWithFakes(opts: {
	actorId: string
	db: FakeDb
}): Hono {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db' as never, opts.db as unknown)
		c.set('actorId' as never, opts.actorId as unknown)
		await next()
	})
	app.route('/api/integrations/linkedin-unipile', integrationsLinkedinUnipileRoutes)
	return app
}

const WORKSPACE_ID = 'ws-1'
const ACTOR_A = 'actor-a'
const ACTOR_B = 'actor-b'

beforeEach(() => {
	vi.mocked(getIntegrationCredential).mockReset()
	vi.mocked(isWorkspaceMember).mockResolvedValue(true)
	__setUnipileClientForTests(null)
})

afterEach(() => {
	__setUnipileClientForTests(null)
})

function stubCredential(actorId: string, accountId: string, accountStatus?: string) {
	vi.mocked(getIntegrationCredential).mockImplementation(
		async (_db, _ws, provider, requestedActor) => {
			if (provider !== 'linkedin-unipile') return null
			if (requestedActor !== actorId) return null
			return {
				id: `int-${actorId}`,
				workspaceId: WORKSPACE_ID,
				provider: 'linkedin-unipile',
				status: 'connected',
				credentials: JSON.stringify({ account_id: accountId, account_status: accountStatus }),
				externalId: null,
				config: {},
				metadata: null,
				actorId,
				createdBy: actorId,
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never
		},
	)
}

function fakeUnipile(
	overrides: Partial<{
		send: (payload: { account_id: string }) => Promise<{
			status: number
			body: unknown
			headers: Record<string, string>
		}>
		reply: (payload: { account_id: string; thread_id: string }) => Promise<{
			status: number
			body: unknown
			headers: Record<string, string>
		}>
		list: (payload: { account_id: string }) => Promise<{
			status: number
			body: unknown
			headers: Record<string, string>
		}>
	}>,
) {
	const send =
		overrides.send ??
		(async () => ({
			status: 200,
			body: { id: 'msg-1', sent_at: '2026-08-31T12:00:00Z' },
			headers: {},
		}))
	const reply = overrides.reply ?? send
	const list =
		overrides.list ?? (async () => ({ status: 200, body: { conversations: [] }, headers: {} }))
	// Params are annotated rather than inferred: the `as never` below erases the
	// contextual type the object literal would otherwise get from UnipileClient,
	// which leaves these three implicitly `any` under `noImplicitAny`.
	__setUnipileClientForTests(
		() =>
			({
				sendMessage: (payload: { account_id: string }) => send(payload),
				reply: (payload: { account_id: string; thread_id: string }) => reply(payload),
				listConversations: (payload: { account_id: string }) => list(payload),
			}) as never,
	)
}

function req(app: Hono, method: 'GET' | 'POST', path: string, body?: unknown, actorId = ACTOR_A) {
	return app.request(`/api/integrations/linkedin-unipile${path}`, {
		method,
		headers: {
			'x-workspace-id': WORKSPACE_ID,
			'content-type': 'application/json',
			'x-test-actor': actorId,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

describe('POST /send-message — six error classes', () => {
	it('CREDENTIAL_NOT_CONNECTED — no credential row', async () => {
		vi.mocked(getIntegrationCredential).mockResolvedValue(null)
		fakeUnipile({})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-1',
		})
		const json = (await res.json()) as { error?: { code?: string } }
		expect(json.error?.code).toBe('CREDENTIAL_NOT_CONNECTED')
	})

	it('CREDENTIAL_REVOKED — account_status RESTRICTED short-circuits pre-flight', async () => {
		stubCredential(ACTOR_A, 'unipile-A', 'RESTRICTED')
		fakeUnipile({})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-2',
		})
		const json = (await res.json()) as { error?: { code?: string } }
		expect(json.error?.code).toBe('CREDENTIAL_REVOKED')
	})

	it('LINKEDIN_ACCOUNT_RESTRICTED — Unipile body marker on send', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		fakeUnipile({
			send: async () => ({
				status: 422,
				body: { error_code: 'account_restricted', message: 'restricted' },
				headers: {},
			}),
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-3',
		})
		const json = (await res.json()) as { error?: { code?: string } }
		expect(json.error?.code).toBe('LINKEDIN_ACCOUNT_RESTRICTED')
	})

	it('RATE_LIMITED_UNIPILE — surfaces after 3 attempts', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		fakeUnipile({
			send: async () => {
				calls++
				return { status: 429, body: {}, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-4',
		})
		const json = (await res.json()) as { error?: { code?: string } }
		expect(json.error?.code).toBe('RATE_LIMITED_UNIPILE')
		expect(calls).toBe(3)
	})

	it('UNIPILE_UNAVAILABLE — surfaces after 3 attempts on 5xx', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		fakeUnipile({
			send: async () => {
				calls++
				return { status: 503, body: {}, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-5',
		})
		const json = (await res.json()) as { error?: { code?: string } }
		expect(json.error?.code).toBe('UNIPILE_UNAVAILABLE')
		expect(calls).toBe(3)
	})

	it('INVALID_INPUT — bad payload rejected before Unipile is called', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let called = false
		fakeUnipile({
			send: async () => {
				called = true
				return { status: 200, body: { id: 'x', sent_at: '2026-08-31T12:00:00Z' }, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			body: 'hi',
			idempotency_key: 'k-6',
		})
		const json = (await res.json()) as { error?: { code?: string } }
		expect(json.error?.code).toBe('INVALID_INPUT')
		expect(called).toBe(false)
	})
})

describe('POST /send-message — idempotency dedup', () => {
	it('replays the winner on a second call with the same key; one Unipile call total', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		fakeUnipile({
			send: async () => {
				calls++
				return {
					status: 200,
					body: { id: `msg-${calls}`, sent_at: '2026-08-31T12:00:00Z' },
					headers: {},
				}
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const first = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'dedup-key',
		})
		const firstJson = (await first.json()) as { message_id: string; replayed: boolean }
		expect(firstJson.message_id).toBe('msg-1')
		expect(firstJson.replayed).toBe(false)

		const second = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'dedup-key',
		})
		const secondJson = (await second.json()) as { message_id: string; replayed: boolean }
		expect(secondJson.message_id).toBe('msg-1')
		expect(secondJson.replayed).toBe(true)
		expect(calls).toBe(1)
	})
})

describe('two-actor lookup isolation', () => {
	it("routes actor A's send to A's Unipile account_id, never B's", async () => {
		let seenAccountId: string | null = null
		vi.mocked(getIntegrationCredential).mockImplementation(async (_db, _ws, _provider, actorId) => {
			if (actorId === ACTOR_A) {
				return {
					id: 'int-A',
					workspaceId: WORKSPACE_ID,
					provider: 'linkedin-unipile',
					status: 'connected',
					credentials: JSON.stringify({ account_id: 'unipile-A' }),
					externalId: null,
					config: {},
					metadata: null,
					actorId: ACTOR_A,
					createdBy: ACTOR_A,
					createdAt: new Date(),
					updatedAt: new Date(),
				} as never
			}
			if (actorId === ACTOR_B) {
				return {
					id: 'int-B',
					workspaceId: WORKSPACE_ID,
					provider: 'linkedin-unipile',
					status: 'connected',
					credentials: JSON.stringify({ account_id: 'unipile-B' }),
					externalId: null,
					config: {},
					metadata: null,
					actorId: ACTOR_B,
					createdBy: ACTOR_B,
					createdAt: new Date(),
					updatedAt: new Date(),
				} as never
			}
			return null
		})
		fakeUnipile({
			send: async (payload) => {
				seenAccountId = payload.account_id
				return { status: 200, body: { id: 'msg-x', sent_at: '2026-08-31T12:00:00Z' }, headers: {} }
			},
		})
		const db = buildFakeDb()
		const appA = buildAppWithFakes({ actorId: ACTOR_A, db })
		await req(
			appA,
			'POST',
			'/send-message',
			{
				recipient_urn: 'urn:li:person:X',
				body: 'hi',
				idempotency_key: 'iso-key-A',
			},
			ACTOR_A,
		)
		expect(seenAccountId).toBe('unipile-A')

		seenAccountId = null
		const appB = buildAppWithFakes({ actorId: ACTOR_B, db })
		await req(
			appB,
			'POST',
			'/send-message',
			{
				recipient_urn: 'urn:li:person:Y',
				body: 'hi',
				idempotency_key: 'iso-key-B',
			},
			ACTOR_B,
		)
		expect(seenAccountId).toBe('unipile-B')

		expect(vi.mocked(decrypt)).toHaveBeenCalled()
	})
})

describe('GET /list-conversations — reads are NOT idempotency-tracked', () => {
	it('does not write to idempotency_records on a read', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		fakeUnipile({
			list: async () => ({
				status: 200,
				body: {
					conversations: [
						{
							thread_id: 't1',
							participants: [{ recipient_urn: 'urn:li:person:X', display_name: 'X' }],
							last_message_at: '2026-08-31T12:00:00Z',
							unread_count: 0,
							preview: 'hello',
						},
					],
				},
				headers: {},
			}),
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'GET', '/list-conversations')
		expect(res.status).toBe(200)
		const json = (await res.json()) as { conversations: unknown[] }
		expect(Array.isArray(json.conversations)).toBe(true)
		expect(db.insert).not.toHaveBeenCalled()
	})
})
