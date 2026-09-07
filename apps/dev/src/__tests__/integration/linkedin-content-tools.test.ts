import { INTEGRATION_STATUS_ACTIVE, integrations, linkedinToolCalls } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PurgeIdempotencyJob } from '../../jobs/purge-idempotency'
import { encrypt } from '../../lib/crypto'
import { __setUnipileClientForTests } from '../../lib/integrations/providers/linkedin-unipile/operations'
import {
	getLinkedInPostEngagement,
	publishLinkedInPost,
} from '../../lib/integrations/providers/linkedin-unipile/operations'
import type { UnipileClient } from '../../lib/integrations/providers/linkedin-unipile/unipile-client'
import { insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

/**
 * Real-Postgres coverage for Task 7b's dedup ledger + purge extension.
 *
 * Two identical `publishLinkedInPost` calls within the 24h TTL must fire
 * Unipile ONCE and return identical responses (with `replayed: true` on the
 * second call). Two identical calls with a stale prior row (>24h) fire
 * Unipile TWICE. The purge job clears any linkedin_tool_calls row older than
 * 24h — the parent-bet spec's TTL — leaving younger rows in place so live
 * dedup keeps working.
 *
 * These invariants are the whole point of the ledger and cannot be exercised
 * against mocked-DB harnesses: `ON CONFLICT DO NOTHING` semantics, primary-key
 * collision behaviour, and the age-based purge all require real Postgres. See
 * `.claude/rules/verification.md`.
 */

const ENCRYPTION_KEY = 'a'.repeat(64)

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = ENCRYPTION_KEY
	process.env.UNIPILE_BASE_URL = 'http://ignored-by-test-stub'
	process.env.UNIPILE_API_KEY = 'ignored-by-test-stub'
})

afterAll(() => {
	__setUnipileClientForTests(null)
})

beforeEach(() => {
	__setUnipileClientForTests(null)
})

async function insertConnectedLinkedInCredential(workspaceId: string, actorId: string) {
	const credentialsBlob = encrypt(
		JSON.stringify({
			account_id: 'mock-account-id',
			account_status: 'OK',
		}),
	)
	await db.insert(integrations).values({
		workspaceId,
		provider: 'linkedin-unipile',
		status: INTEGRATION_STATUS_ACTIVE,
		credentials: credentialsBlob,
		actorId,
		createdBy: actorId,
	})
}

function stubbedUnipileClient(
	overrides: Partial<UnipileClient> = {},
): UnipileClient & { publishCalls: unknown[] } {
	const publishCalls: unknown[] = []
	const client: UnipileClient = {
		sendMessage: vi.fn(),
		reply: vi.fn(),
		listConversations: vi.fn(),
		listMessages: vi.fn(),
		listRelations: vi.fn(),
		searchPeople: vi.fn(),
		getProfile: vi.fn(),
		publishPost: async (payload) => {
			publishCalls.push(payload)
			return {
				status: 200,
				body: {
					object: 'PostPublished',
					post_id: `stub-post-${publishCalls.length}`,
					published_at: '2026-09-01T10:00:00.000Z',
				},
				headers: {},
			}
		},
		commentOnPost: vi.fn(),
		replyToComment: vi.fn(),
		readPostComments: vi.fn(),
		retrievePost: vi.fn(),
		listReactions: vi.fn(),
		countComments: vi.fn(),
		...overrides,
	}
	return Object.assign(client, { publishCalls })
}

describe('linkedin_tool_calls content-hash idempotency (Task 7b)', () => {
	it('replays a stored response when the same publish fires twice within 24h', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await insertConnectedLinkedInCredential(ws.id, actorId)

		const client = stubbedUnipileClient()
		__setUnipileClientForTests(() => client)

		const input = { text: 'Hello LinkedIn 👋' }
		const first = await publishLinkedInPost({ db, actorId, workspaceId: ws.id }, input)
		const second = await publishLinkedInPost({ db, actorId, workspaceId: ws.id }, input)

		expect(client.publishCalls).toHaveLength(1)
		expect(first.replayed).toBe(false)
		expect(second.replayed).toBe(true)
		// The replay body must match the first response byte-for-byte on the
		// caller-visible fields; the `replayed` flag is the only difference.
		expect(second.post_id).toBe(first.post_id)
		expect(second.published_at).toBe(first.published_at)

		const rows = await db
			.select()
			.from(linkedinToolCalls)
			.where(
				and(
					eq(linkedinToolCalls.actorId, actorId),
					eq(linkedinToolCalls.tool, 'linkedin_publish_post'),
				),
			)
		expect(rows).toHaveLength(1)
	})

	it('fires Unipile twice when the prior dedup row is older than the 24h TTL', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await insertConnectedLinkedInCredential(ws.id, actorId)

		const client = stubbedUnipileClient()
		__setUnipileClientForTests(() => client)

		const input = { text: 'Stale replay test' }
		await publishLinkedInPost({ db, actorId, workspaceId: ws.id }, input)
		// Force the dedup row 25h into the past — beyond the 24h TTL. The next
		// identical call should NOT replay: content-hash dedup collapses after
		// the caller's retry window.
		await sql`UPDATE linkedin_tool_calls SET created_at = now() - interval '25 hours'`

		const second = await publishLinkedInPost({ db, actorId, workspaceId: ws.id }, input)

		expect(client.publishCalls).toHaveLength(2)
		expect(second.replayed).toBe(false)
	})

	it('never publishes twice when two identical calls overlap', async () => {
		// Regression: the ledger was originally check-then-act (SELECT prior, run,
		// INSERT ... ON CONFLICT DO NOTHING), so two concurrent identical calls
		// both missed the SELECT and both published to the customer's feed, and
		// the loser's row was silently swallowed by the ON CONFLICT — leaving a
		// stored response that belonged to a different real post. A duplicate
		// public post is user-visible and we cannot retract it, so the claim must
		// be taken BEFORE the Unipile call. Mirrors the messaging surface's
		// overlap test in routes/__tests__/integrations-linkedin-unipile.test.ts.
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await insertConnectedLinkedInCredential(ws.id, actorId)

		// Hold the first publish open until the second call has gone past the
		// point where a check-then-act implementation would have read the ledger.
		let releaseFirst: () => void = () => {}
		const firstInFlight = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const publishCalls: unknown[] = []
		const client = stubbedUnipileClient({
			publishPost: async (payload) => {
				publishCalls.push(payload)
				if (publishCalls.length === 1) await firstInFlight
				return {
					status: 200,
					body: {
						object: 'PostPublished',
						post_id: `stub-post-${publishCalls.length}`,
						published_at: '2026-09-01T10:00:00.000Z',
					},
					headers: {},
				}
			},
		})
		client.publishCalls = publishCalls
		__setUnipileClientForTests(() => client)

		const input = { text: 'Concurrent publish' }
		const first = publishLinkedInPost({ db, actorId, workspaceId: ws.id }, input)
		// The loser must not publish. It either replays or refuses as retryable —
		// both are correct, and both are the opposite of publishing again.
		const second = publishLinkedInPost({ db, actorId, workspaceId: ws.id }, input).catch(
			(err: Error) => err,
		)
		const secondResult = await second
		releaseFirst()
		await first

		expect(publishCalls).toHaveLength(1)
		if (secondResult instanceof Error) {
			expect(secondResult.message).toMatch(/already in flight/i)
		} else {
			expect(secondResult.replayed).toBe(true)
		}

		const rows = await db.select().from(linkedinToolCalls)
		expect(rows).toHaveLength(1)
	})

	it('diverges hash for different bodies so distinct posts do not collide', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await insertConnectedLinkedInCredential(ws.id, actorId)

		const client = stubbedUnipileClient()
		__setUnipileClientForTests(() => client)

		await publishLinkedInPost({ db, actorId, workspaceId: ws.id }, { text: 'first' })
		await publishLinkedInPost({ db, actorId, workspaceId: ws.id }, { text: 'second' })

		expect(client.publishCalls).toHaveLength(2)
		const rows = await db.select().from(linkedinToolCalls)
		expect(rows).toHaveLength(2)
	})
})

describe('PurgeIdempotencyJob linkedin_tool_calls extension', () => {
	it('deletes only rows older than the 24h TTL', async () => {
		const actorId = getTestActorId()

		await db.insert(linkedinToolCalls).values([
			{
				actorId,
				tool: 'linkedin_publish_post',
				contentHash: 'hash-old',
				response: { post_id: 'p-old' },
			},
			{
				actorId,
				tool: 'linkedin_publish_post',
				contentHash: 'hash-fresh',
				response: { post_id: 'p-fresh' },
			},
		])
		// Age one row past the TTL, leave the other fresh.
		await sql`UPDATE linkedin_tool_calls SET created_at = now() - interval '25 hours' WHERE content_hash = 'hash-old'`

		const job = new PurgeIdempotencyJob(db)
		await job.tick()

		const survivors = await db.select().from(linkedinToolCalls)
		expect(survivors).toHaveLength(1)
		expect(survivors[0].contentHash).toBe('hash-fresh')
	})
})

describe('get_post_engagement fan-out', () => {
	it('returns partial envelope with is_partial=true when listReactions fails mid-cursor', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await insertConnectedLinkedInCredential(ws.id, actorId)

		let reactionCall = 0
		const client = stubbedUnipileClient({
			retrievePost: async () => ({
				status: 200,
				body: {
					object: 'Post',
					id: 'p1',
					author_urn: 'urn:li:person:me',
					published_at: '2026-09-01T10:00:00Z',
					text: 'A post',
				},
				headers: {},
			}),
			listReactions: async () => {
				reactionCall++
				if (reactionCall === 1) {
					return {
						status: 200,
						body: {
							data: [
								{ user_id: 'u1', reaction_type: 'LIKE' },
								{ user_id: 'u2', reaction_type: 'CELEBRATE' },
							],
							next_cursor: 'cursor-1',
						},
						headers: {},
					}
				}
				return { status: 502, body: { message: 'gateway timeout' }, headers: {} }
			},
			countComments: async () => ({
				status: 200,
				body: { paging: { total_count: 4 } },
				headers: {},
			}),
		})
		__setUnipileClientForTests(() => client)

		const result = await getLinkedInPostEngagement(
			{ db, actorId, workspaceId: ws.id },
			{ post_id: 'p1' },
		)
		expect(result.post_id).toBe('p1')
		// Page 1 collected: 2 reactions. Page 2 failed → partial marker set,
		// no more counting.
		expect(result.reactions.total).toBe(2)
		expect(result.reactions.sample.length).toBeGreaterThan(0)
		expect(result.comments.total).toBe(4)
		expect(result.is_partial).toBe(true)
		expect(result.partial_errors.reactions).not.toBeNull()
		expect(result.partial_errors.comments).toBeNull()
	})

	it('returns is_partial=false when all three sub-calls succeed', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		await insertConnectedLinkedInCredential(ws.id, actorId)

		const client = stubbedUnipileClient({
			retrievePost: async () => ({
				status: 200,
				body: { id: 'p1', author_urn: 'urn:li:person:me', text: 'A post' },
				headers: {},
			}),
			listReactions: async () => ({
				status: 200,
				body: {
					data: [{ user_id: 'u1', reaction_type: 'LIKE' }],
				},
				headers: {},
			}),
			countComments: async () => ({
				status: 200,
				body: { paging: { total_count: 0 } },
				headers: {},
			}),
		})
		__setUnipileClientForTests(() => client)

		const result = await getLinkedInPostEngagement(
			{ db, actorId, workspaceId: ws.id },
			{ post_id: 'p1' },
		)
		expect(result.is_partial).toBe(false)
		expect(result.reactions.total).toBe(1)
		expect(result.comments.total).toBe(0)
		expect(result.partial_errors.reactions).toBeNull()
		expect(result.partial_errors.comments).toBeNull()
	})
})
