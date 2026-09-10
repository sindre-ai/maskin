/**
 * R11-B · Destructive post CRUD (edit + delete) — coverage against BOTH a
 * personal-instance context AND a page-instance context.
 *
 * R11-A pre-scopes identity at register-time, so at the operation layer the
 * two contexts differ only in the actorId the ledger keys on — the code path
 * is otherwise the same. Iterating each case over both actor ids surfaces any
 * regression that couples one identity type to a code branch.
 *
 * Verification harness:
 *   - `createTestContext()` (the standard unit-test mock DB) — the Proxy
 *     returns `[]` for every query by default, and the operations' claim
 *     insert / claim update / claim release delete all become no-ops. That is
 *     exactly the "happy path through the ledger" every case here needs.
 *   - The dedup semantics themselves (two identical calls collide on the
 *     primary key, replay stored response, purge after 24h) are covered by
 *     the real-Postgres integration suite in
 *     `apps/dev/src/__tests__/integration/linkedin-content-tools.test.ts`,
 *     which the parent bet already ships. Nothing to duplicate here.
 *   - A stub `LinkedInClient` records every editPost/deletePost call and
 *     lets each case pin the next response (200, 400 POST_NOT_FOUND, or a
 *     generic 500), so the three failure branches — happy path, already-
 *     deleted no-op, non-author fail — can be exercised without spinning up
 *     the HTTP mock server. The `__mocks__/handlers/posts-crud.ts` mock
 *     (spec §9.1) is exercised by the client's own unit tests.
 *
 * `apps/dev/src/routes/__tests__/` is the location the R11-B task pins for
 * this suite (spec §9.2 / task acceptance criteria).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestContext } from '../../__tests__/setup'
import {
	type LinkedInIntegrationError,
	PostNotFoundError,
	isLinkedInIntegrationError,
} from '../../lib/integrations/providers/linkedin-unipile/errors'
import {
	type LinkedInOperationContext,
	__setLinkedInClientForTests,
	deleteLinkedInPost,
	editLinkedInPost,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type {
	LinkedInClient,
	LinkedInDeletePostPayload,
	LinkedInEditPostPayload,
} from '../../lib/integrations/providers/linkedin-unipile/unipile-client'

// ── Preamble stubbing ──────────────────────────────────────────────────────
//
// operations.preamble() runs three lookups (workspace membership, credential
// row fetch, credential decrypt). All three are stubbed so the tests focus on
// the edit/delete operation itself. Stubs are hoisted so they replace the
// real modules for every case in the file.

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: async () => true,
}))

vi.mock('../../lib/integrations/lookup', () => ({
	getIntegrationCredential: async () => ({
		id: 'integration-1',
		actorId: 'human-actor',
		credentials: JSON.stringify({ account_id: 'mock-account-id', account_status: 'OK' }),
	}),
}))

vi.mock('../../lib/crypto', () => ({
	// The real preamble runs `JSON.parse(decrypt(row.credentials))`; since we
	// hand it plain JSON above, `decrypt` becomes a pass-through.
	decrypt: (s: string) => s,
}))

// ── Stub LinkedIn client ───────────────────────────────────────────────────
//
// Records every mutating call and lets each case pin the next response per
// method. Supports the three response shapes the tests need:
//   - default:              200 happy path
//   - 'post-not-found':     400 POST_NOT_FOUND envelope (spec §5)
//   - 'unavailable':        500 unclassified (surfaces as LINKEDIN_UNAVAILABLE)

type NextResp = 'ok' | 'post-not-found' | 'unavailable'

function makeStubClient() {
	const editCalls: LinkedInEditPostPayload[] = []
	const deleteCalls: LinkedInDeletePostPayload[] = []
	let nextEdit: NextResp = 'ok'
	let nextDelete: NextResp = 'ok'

	const notFoundBody = {
		object: 'Error',
		error_code: 'post_not_found',
		message: 'The post you are trying to modify could not be found for this LinkedIn account.',
	}

	function buildResp(
		kind: NextResp,
		okStatus: number,
		okBody: Record<string, unknown>,
	): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
		if (kind === 'post-not-found') return { status: 400, body: notFoundBody, headers: {} }
		if (kind === 'unavailable') return { status: 500, body: { error: 'boom' }, headers: {} }
		return { status: okStatus, body: okBody, headers: {} }
	}

	const client: LinkedInClient = {
		sendMessage: vi.fn(),
		reply: vi.fn(),
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		listRelations: vi.fn(),
		searchPeople: vi.fn(),
		getProfile: vi.fn(),
		sendConnectionRequest: vi.fn(),
		publishPost: vi.fn(),
		commentOnPost: vi.fn(),
		replyToComment: vi.fn(),
		readPostComments: vi.fn(),
		retrievePost: vi.fn(),
		listReactions: vi.fn(),
		countComments: vi.fn(),
		editPost: async (payload) => {
			editCalls.push(payload)
			const kind = nextEdit
			nextEdit = 'ok'
			return buildResp(kind, 200, {
				object: 'PostUpdated',
				post_id: payload.post_id,
				edited_at: '2026-09-02T10:15:00.000Z',
			})
		},
		deletePost: async (payload) => {
			deleteCalls.push(payload)
			const kind = nextDelete
			nextDelete = 'ok'
			// Live LinkedIn returns 204 no-content on success.
			return buildResp(kind, 204, {})
		},
	}

	return {
		client,
		editCalls,
		deleteCalls,
		setNextEdit: (r: NextResp) => {
			nextEdit = r
		},
		setNextDelete: (r: NextResp) => {
			nextDelete = r
		},
	}
}

// ── Fixtures for the two identity contexts ─────────────────────────────────
//
// R11-A pre-scopes identity at register-time via
// `LinkedInMcpInstanceConfig.identityUrn`. In the current shell we simulate
// personal vs page identities by using distinct `actorId`s. The ledger keys
// on actorId today; in R11-A's finished world the identitySlug is baked into
// the tool name and the (actor, tool) tuple carries the same separation.

const PERSONAL_CTX_ACTOR = 'actor-personal-instance'
const PAGE_CTX_ACTOR = 'actor-page-instance'

function ctxFor(actorId: string): LinkedInOperationContext {
	const { db } = createTestContext()
	return { db, actorId, workspaceId: 'ws-1' }
}

// ── Env for the operations layer ──────────────────────────────────────────
//
// operations.buildLinkedInClient() reads UNIPILE_BASE_URL + UNIPILE_API_KEY
// when the client override is not set. `__setLinkedInClientForTests` bypasses
// that path but the env-existence guard runs first — set both env vars so a
// stray real-client build doesn't tank the suite.

const ORIGINAL_ENV = {
	UNIPILE_BASE_URL: process.env.UNIPILE_BASE_URL,
	UNIPILE_API_KEY: process.env.UNIPILE_API_KEY,
}

beforeEach(() => {
	process.env.UNIPILE_BASE_URL = 'http://ignored-by-stub'
	process.env.UNIPILE_API_KEY = 'ignored-by-stub'
})

afterEach(() => {
	__setLinkedInClientForTests(null)
	process.env.UNIPILE_BASE_URL = ORIGINAL_ENV.UNIPILE_BASE_URL
	process.env.UNIPILE_API_KEY = ORIGINAL_ENV.UNIPILE_API_KEY
})

// ── Cases ──────────────────────────────────────────────────────────────────

describe.each([
	{ label: 'personal-instance context', actorId: PERSONAL_CTX_ACTOR },
	{ label: 'page-instance context', actorId: PAGE_CTX_ACTOR },
])('__edit_post ($label)', ({ actorId }) => {
	it('happy path: edits the post and returns { post_id, edited_at }', async () => {
		const stub = makeStubClient()
		__setLinkedInClientForTests(() => stub.client)

		const result = await editLinkedInPost(ctxFor(actorId), {
			post_id: 'mock-post-1',
			text: 'updated body',
		})

		expect(result.replayed).toBe(false)
		expect(result.post_id).toBe('mock-post-1')
		expect(result.edited_at).toBeTruthy()
		expect(stub.editCalls).toHaveLength(1)
		expect(stub.editCalls[0]).toMatchObject({
			account_id: 'mock-account-id',
			post_id: 'mock-post-1',
			text: 'updated body',
		})
	})

	it('happy path with only can_comment: edits the post without setting text', async () => {
		const stub = makeStubClient()
		__setLinkedInClientForTests(() => stub.client)

		const result = await editLinkedInPost(ctxFor(actorId), {
			post_id: 'mock-post-1',
			can_comment: 'no_one',
		})
		expect(result.post_id).toBe('mock-post-1')
		expect(stub.editCalls[0]).toMatchObject({
			post_id: 'mock-post-1',
			can_comment: 'no_one',
		})
		expect(stub.editCalls[0]?.text).toBeUndefined()
	})

	it('non-author fail: LinkedIn returns POST_NOT_FOUND and the edit surfaces as POST_NOT_FOUND to the caller', async () => {
		const stub = makeStubClient()
		stub.setNextEdit('post-not-found')
		__setLinkedInClientForTests(() => stub.client)

		let caught: unknown
		try {
			await editLinkedInPost(ctxFor(actorId), {
				post_id: 'someone-elses-post',
				text: 'x',
			})
		} catch (err) {
			caught = err
		}
		expect(isLinkedInIntegrationError(caught)).toBe(true)
		expect((caught as LinkedInIntegrationError).code).toBe('POST_NOT_FOUND')
		expect(stub.editCalls).toHaveLength(1)
	})

	it('rejects an edit that carries neither text nor can_comment (validation runs before the Unipile call)', async () => {
		const stub = makeStubClient()
		__setLinkedInClientForTests(() => stub.client)

		let caught: unknown
		try {
			await editLinkedInPost(ctxFor(actorId), { post_id: 'mock-post-1' })
		} catch (err) {
			caught = err
		}
		expect(isLinkedInIntegrationError(caught)).toBe(true)
		expect((caught as LinkedInIntegrationError).code).toBe('INVALID_INPUT')
		expect(stub.editCalls).toHaveLength(0)
	})
})

describe.each([
	{ label: 'personal-instance context', actorId: PERSONAL_CTX_ACTOR },
	{ label: 'page-instance context', actorId: PAGE_CTX_ACTOR },
])('__delete_post ($label)', ({ actorId }) => {
	it('happy path: deletes the post and returns { post_id, deleted_at, already_deleted: false }', async () => {
		const stub = makeStubClient()
		__setLinkedInClientForTests(() => stub.client)

		const result = await deleteLinkedInPost(ctxFor(actorId), { post_id: 'mock-post-1' })
		expect(result.replayed).toBe(false)
		expect(result.post_id).toBe('mock-post-1')
		expect(result.already_deleted).toBe(false)
		expect(stub.deleteCalls).toHaveLength(1)
		expect(stub.deleteCalls[0]).toMatchObject({
			account_id: 'mock-account-id',
			post_id: 'mock-post-1',
		})
	})

	it('already-deleted no-op: LinkedIn returns POST_NOT_FOUND and delete returns { already_deleted: true } as success', async () => {
		const stub = makeStubClient()
		stub.setNextDelete('post-not-found')
		__setLinkedInClientForTests(() => stub.client)

		const result = await deleteLinkedInPost(ctxFor(actorId), { post_id: 'mock-post-1' })
		expect(result.already_deleted).toBe(true)
		expect(result.post_id).toBe('mock-post-1')
		expect(stub.deleteCalls).toHaveLength(1)
	})

	it('non-author fail: LinkedIn returns POST_NOT_FOUND for the SAME reason as already-deleted, and delete succeeds as a no-op (agents treat all three POST_NOT_FOUND modes the same)', async () => {
		// LinkedIn does not distinguish "post never existed", "already deleted",
		// and "not authored by this identity" in its response envelope — all
		// three surface as POST_NOT_FOUND. Delete must fold every one of those
		// into the success no-op envelope (spec §5). The distinction only
		// matters at agent-authoring time, not at API time.
		const stub = makeStubClient()
		stub.setNextDelete('post-not-found')
		__setLinkedInClientForTests(() => stub.client)

		const result = await deleteLinkedInPost(ctxFor(actorId), {
			post_id: 'post-authored-by-someone-else',
		})
		expect(result.already_deleted).toBe(true)
	})

	it('surfaces non-POST_NOT_FOUND LinkedIn errors as-is on delete', async () => {
		// A 500-shaped failure on delete is NOT the "already gone" case — it
		// must propagate rather than get swallowed as a success no-op.
		const stub = makeStubClient()
		stub.setNextDelete('unavailable')
		__setLinkedInClientForTests(() => stub.client)

		let caught: unknown
		try {
			await deleteLinkedInPost(ctxFor(actorId), { post_id: 'mock-post-1' })
		} catch (err) {
			caught = err
		}
		expect(isLinkedInIntegrationError(caught)).toBe(true)
		expect((caught as LinkedInIntegrationError).code).toBe('LINKEDIN_UNAVAILABLE')
	})
})

describe('PostNotFoundError construction (spec §5)', () => {
	it('exposes POST_NOT_FOUND as its code and the exact spec §5 message', () => {
		const err = new PostNotFoundError()
		expect(err.code).toBe('POST_NOT_FOUND')
		expect(err.retryable).toBe(false)
		expect(err.message).toBe('Post not found, already deleted, or not authored by this identity.')
	})
})
