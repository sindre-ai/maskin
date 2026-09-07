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

// vi.fn(), not plain functions — the isolation test below asserts on
// `vi.mocked(decrypt)`, which throws "not a spy" against a bare function.
vi.mock('../../lib/crypto', () => ({
	decrypt: vi.fn((s: string) => s),
	encrypt: vi.fn((s: string) => s),
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
	rows: IdempotencyRow[]
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
	createdAt?: Date
}

/**
 * Build a fake DB with an in-memory idempotency_records table.
 *
 * The drizzle predicates are opaque objects, so instead of parsing them the
 * fake tracks `currentKey` — the key of the most recent insert attempt. That
 * is faithful to the code under test: `withIdempotency` derives one scopedKey
 * per call and uses that same key for every subsequent select/update/delete.
 *
 * Insert enforces PK uniqueness (code '23505'), which is what makes the claim
 * atomic and therefore what serialises concurrent callers. Update mutates the
 * stored row so a completed claim really does replay its recorded response.
 *
 * `update().set().where()` is both awaitable and `.returning()`-able because
 * the code uses it two ways: an unconditional completion write, and a
 * conditional stale-claim takeover. `returning: []` means "no stale row
 * matched" — correct for every test here, since none of them let a claim age
 * past the TTL.
 */
function buildFakeDb(initial: IdempotencyRow[] = []): FakeDb {
	const rows: IdempotencyRow[] = [...initial]
	let currentKey: string | null = null
	const find = () => rows.find((r) => r.key === currentKey)
	return {
		rows,
		select: vi.fn(() => ({
			from: () => ({
				where: (_predicate: unknown) => ({
					limit: (_n: number) => {
						const row = find()
						return Promise.resolve(row ? [row] : [])
					},
				}),
			}),
		})),
		insert: vi.fn(() => ({
			values: (row: IdempotencyRow) => {
				currentKey = row.key
				if (rows.some((r) => r.key === row.key)) {
					const err = new Error('duplicate key value violates unique constraint')
					;(err as Error & { code: string }).code = '23505'
					throw err
				}
				rows.push({ createdAt: new Date(), ...row })
				return Promise.resolve()
			},
		})),
		update: vi.fn(() => ({
			set: (values: Partial<IdempotencyRow>) => ({
				where: () => {
					// A completion write (carries `status`) always applies. A
					// takeover write carries only `createdAt` and is conditional on
					// the claim being stale — no test here ages a claim past the
					// TTL, so it matches nothing and must not mutate the row.
					if ('status' in values) {
						const row = find()
						if (row) Object.assign(row, values)
					}
					return Object.assign(Promise.resolve(undefined), {
						returning: () => Promise.resolve([]),
					})
				},
			}),
		})),
		delete: vi.fn(() => ({
			where: () => {
				const idx = rows.findIndex((r) => r.key === currentKey)
				if (idx >= 0) rows.splice(idx, 1)
				return Promise.resolve()
			},
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
				status: 'active',
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

	it('UNIPILE_UNAVAILABLE — a 5xx on a SEND is not replayed', async () => {
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
		// Exactly one attempt. A 5xx on a send is ambiguous — Unipile may have
		// already handed the message to LinkedIn and failed only on the way back
		// — so replaying it inside the single idempotency claim would deliver the
		// message twice while the caller sees one success. 429 is different (see
		// the RATE_LIMITED case above): rejected before execution, so still safe
		// to retry.
		expect(calls).toBe(1)
	})

	it('UNIPILE_UNAVAILABLE — a 5xx on a READ still retries, since reads cannot duplicate', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		fakeUnipile({
			list: async () => {
				calls++
				return { status: 503, body: {}, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'GET', '/list-conversations')
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

	// Regression: the ledger used to be check-then-act (SELECT, send, INSERT),
	// so two concurrent calls with one key both missed the SELECT and both sent.
	// The loser then reported replayed:true having already delivered a second
	// LinkedIn message. The claim row must be written before the send.
	it('never sends twice when two calls with the same key overlap', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		let releaseFirst: () => void = () => {}
		const firstInFlight = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		fakeUnipile({
			send: async () => {
				calls++
				if (calls === 1) await firstInFlight
				return {
					status: 200,
					body: { id: `msg-${calls}`, sent_at: '2026-08-31T12:00:00Z' },
					headers: {},
				}
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const body = {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'concurrent-key',
		}

		const firstPromise = req(app, 'POST', '/send-message', body)
		// Let the first request claim the key and reach the (blocked) send.
		await new Promise((r) => setTimeout(r, 0))
		const second = await req(app, 'POST', '/send-message', body)

		// The duplicate must be refused, not served — the winner's response does
		// not exist yet, so there is nothing legitimate to replay.
		expect(second.status).toBe(502)
		expect(calls).toBe(1)

		releaseFirst()
		const firstJson = (await (await firstPromise).json()) as { message_id: string }
		expect(firstJson.message_id).toBe('msg-1')
		expect(calls).toBe(1)
	})

	// Regression: method and path were absent from the scoped key, so a reply
	// reusing the send's {contact_id}:{draft_id} key replayed the send's stored
	// response and was never delivered.
	it('does not let a reply replay a send that used the same caller key', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		const sent: string[] = []
		fakeUnipile({
			send: async () => {
				sent.push('send')
				return { status: 200, body: { id: 'msg-send' }, headers: {} }
			},
			reply: async () => {
				sent.push('reply')
				return { status: 200, body: { id: 'msg-reply' }, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const sharedKey = 'contact-1:draft-1'

		await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: sharedKey,
		})
		const reply = await req(app, 'POST', '/reply', {
			thread_id: 'thread-1',
			body: 'following up',
			idempotency_key: sharedKey,
		})

		const replyJson = (await reply.json()) as { message_id: string; replayed: boolean }
		expect(replyJson.replayed).toBe(false)
		expect(replyJson.message_id).toBe('msg-reply')
		expect(sent).toEqual(['send', 'reply'])
	})

	// A failed send must release its claim, or a transient upstream error would
	// poison the key until the nightly purge and block every legitimate retry.
	it('releases the claim when the send fails, so a retry can proceed', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		fakeUnipile({
			// 400 → INVALID_INPUT, which is terminal. A 5xx would be retried
			// internally by callUnipileWithRetry and never surface as a failure.
			send: async () => {
				calls++
				if (calls === 1) return { status: 400, body: { message: 'bad urn' }, headers: {} }
				return { status: 200, body: { id: 'msg-2' }, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const body = {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'retry-key',
		}

		const failed = await req(app, 'POST', '/send-message', body)
		expect(failed.status).toBe(400)
		expect(db.rows).toHaveLength(0)

		const retried = await req(app, 'POST', '/send-message', body)
		const retriedJson = (await retried.json()) as { message_id: string; replayed: boolean }
		expect(retriedJson.message_id).toBe('msg-2')
		expect(retriedJson.replayed).toBe(false)
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
					status: 'active',
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
					status: 'active',
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

// ── v2 wire-shape translation ────────────────────────────────────────────
// These pin the response shapes against the Unipile v2 reference pages
// (Start a Chat / Send a Message / List Chats), which the mock server now
// mirrors verbatim. Getting these wrong is invisible: the call returns 200
// and the caller acts on the result.

describe('v2 response normalization', () => {
	it('reads message_id and chat_id from a v2 ChatStarted envelope', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		fakeUnipile({
			send: async () => ({
				status: 200,
				body: { object: 'ChatStarted', chat_id: 'chat-9', message_id: 'msg-9' },
				headers: {},
			}),
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-shape-1',
		})
		const json = (await res.json()) as { message_id?: string; chat_id?: string }
		expect(json.message_id).toBe('msg-9')
		// Without chat_id the agent has no thread to follow up in — v2 returns
		// the new conversation id here and nowhere else.
		expect(json.chat_id).toBe('chat-9')
	})

	it('takes the first id when v2 returns message_id as an array', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		fakeUnipile({
			send: async () => ({
				status: 200,
				body: { object: 'ChatStarted', chat_id: 'chat-1', message_id: ['msg-a', 'msg-b'] },
				headers: {},
			}),
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-shape-2',
		})
		expect(res.status).toBe(200)
		expect(((await res.json()) as { message_id?: string }).message_id).toBe('msg-a')
	})

	it('reports success — not a retryable error — when a 2xx carries no message id', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		let calls = 0
		fakeUnipile({
			send: async () => {
				calls++
				// v2 documents message_id as string | string[] | null.
				return { status: 200, body: { object: 'ChatStarted', message_id: null }, headers: {} }
			},
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'POST', '/send-message', {
			recipient_urn: 'urn:li:person:X',
			body: 'hi',
			idempotency_key: 'k-shape-3',
		})
		// LinkedIn accepted the message. Calling this a retryable 502 would
		// release the idempotency claim and let the caller send a SECOND copy
		// — the duplicate-outreach pattern that gets accounts restricted.
		expect(res.status).toBe(200)
		expect(((await res.json()) as { message_id?: string }).message_id).toBe('')
		expect(calls).toBe(1)
	})

	it('maps v2 chat objects onto the MCP conversation shape', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		fakeUnipile({
			list: async () => ({
				status: 200,
				// v2 nests the page under `data`, and a chat is { id, user_id,
				// last_message_timestamp, unread_count, last_message } — NOT v1's
				// { thread_id, attendees }.
				body: {
					data: [
						{
							object: 'Chat',
							id: 'chat-42',
							name: 'Ada Lovelace',
							user_id: 'user-42',
							unread_count: 3,
							last_message_timestamp: '2026-09-01T10:00:00.000Z',
							last_message: { text: 'Thanks!' },
						},
					],
				},
				headers: {},
			}),
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'GET', '/list-conversations')
		const json = (await res.json()) as {
			conversations?: Array<Record<string, unknown>>
		}
		const [conv] = json.conversations ?? []
		expect(conv).toBeDefined()
		// A bare cast of the v2 item would leave every one of these undefined,
		// and the agent would feed thread_id: undefined straight into reply().
		expect(conv?.thread_id).toBe('chat-42')
		expect(conv?.unread_count).toBe(3)
		expect(conv?.last_message_at).toBe('2026-09-01T10:00:00.000Z')
		expect(conv?.preview).toBe('Thanks!')
		expect(conv?.participants).toEqual([{ recipient_urn: 'user-42', display_name: 'Ada Lovelace' }])
	})

	it('fails loudly when the conversation list has no recognisable array', async () => {
		stubCredential(ACTOR_A, 'unipile-A')
		fakeUnipile({
			list: async () => ({ status: 200, body: { object: 'ChatList' }, headers: {} }),
		})
		const db = buildFakeDb()
		const app = buildAppWithFakes({ actorId: ACTOR_A, db })
		const res = await req(app, 'GET', '/list-conversations')
		// An empty array here would read as "this user has no LinkedIn
		// conversations", which an agent will report to a human as fact. A read
		// has no side effect, so erroring is the safe direction.
		const json = (await res.json()) as { error?: { code?: string }; conversations?: unknown[] }
		expect(json.conversations).toBeUndefined()
		expect(json.error?.code).toBe('UNIPILE_UNAVAILABLE')
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
