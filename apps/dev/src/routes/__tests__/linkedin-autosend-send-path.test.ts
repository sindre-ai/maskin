import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration test for the send path of Task 5
 * (LinkedIn autosend reachable from Sales Rep loop's
 * session, task id 065d2627-6351-4644-9178-eacf867db116).
 *
 * Closes acceptance criterion 6:
 *   - credential connected → the send call fires against the
 *     Task 3 route (POST /api/integrations/linkedin-unipile/send-message)
 *     with the actor's stored Unipile account_id and stores an idempotency
 *     record scoped as
 *     `linkedin-unipile:{actor_id}:{method}:{path}:{contact_id}:{draft_id}`
 *     (the caller's spec §5 key, namespaced so send and reply cannot collide).
 *
 * The route module itself is Task 3's work (PR #1510); the idempotency-key
 * helper came with PR #1512. This file asserts the two compose correctly.
 *
 * Mocking follows the pattern established by the sibling
 * `integrations-linkedin-unipile.test.ts` (also Task 3):
 *   - Credential lookup, workspace-membership check, crypto, and logger are
 *     stubbed so no real DB or crypto material is exercised.
 *   - The Unipile client is injected via the route's test-only setter, so
 *     no network calls fire.
 *   - The retry-policy `delay` is monkey-patched to resolve immediately so
 *     the suite is not gated on wall-clock backoff.
 */

vi.mock('../../lib/integrations/lookup', () => ({
	actorScopedProviders: new Set(['linkedin-unipile']),
	findIntegrationRow: vi.fn(),
	getCredential: vi.fn(),
}))

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
	assertWorkspaceWriterRole: vi.fn(),
}))

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { findIntegrationRow, getCredential } from '../../lib/integrations/lookup'
import { buildLinkedinAutosendIdempotencyKey } from '../../lib/linkedin-autosend'
import { isWorkspaceMember } from '../../lib/workspace-auth'
import integrationsLinkedinUnipileRoutes, {
	__setLinkedInClientForTests,
} from '../integrations-linkedin-unipile'

type IdempotencyRow = {
	key: string
	actorId: string | null
	method: string
	path: string
	status: number
	response: unknown
}

/**
 * In-memory stand-in for the idempotency_records table. Mirrors the shape
 * of `buildFakeDb` in the sibling route test — one row per unique key,
 * primary-key violation surfaces as SQLSTATE 23505.
 */
function buildFakeDb() {
	const rows: IdempotencyRow[] = []
	const db = {
		select: vi.fn(() => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(rows.length > 0 ? [rows[0]] : []),
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
		update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve() }) })),
		delete: vi.fn(() => ({ where: () => ({ returning: () => Promise.resolve([]) }) })),
	}
	return { rows, db }
}

function buildApp(actorId: string, db: unknown): Hono {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('actorId' as never, actorId as never)
		await next()
	})
	app.route('/api/integrations/linkedin-unipile', integrationsLinkedinUnipileRoutes)
	return app
}

const WORKSPACE_ID = 'ws-1'
const DRIVER_ACTOR = 'actor-driver-1'
const CONTACT_ID = 'contact-abc'
const DRAFT_ID = 'draft-xyz'

beforeEach(() => {
	vi.mocked(findIntegrationRow).mockReset()
	vi.mocked(getCredential).mockReset()
	vi.mocked(isWorkspaceMember).mockResolvedValue(true)
	__setLinkedInClientForTests(null)
})

afterEach(() => {
	__setLinkedInClientForTests(null)
})

describe('Sales Rep loop autosend — send path (integration)', () => {
	it('credential connected → send call fires with account_id and expected idempotency key', async () => {
		// 1. Credential — the driver-actor has a linkedin-unipile row.
		vi.mocked(findIntegrationRow).mockImplementation(async (_db, _ws, provider, requestedActor) => {
			if (provider !== 'linkedin-unipile' || requestedActor !== DRIVER_ACTOR) return null
			return {
				id: 'int-driver',
				workspaceId: WORKSPACE_ID,
				provider: 'linkedin-unipile',
				status: 'active',
				credentials: JSON.stringify({ account_id: 'unipile-driver' }),
				externalId: null,
				config: {},
				metadata: null,
				actorId: DRIVER_ACTOR,
				createdBy: DRIVER_ACTOR,
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never
		})
		// The value is read by id through getCredential, scope-checked and audited.
		vi.mocked(getCredential).mockResolvedValue({
			value: JSON.stringify({ account_id: 'unipile-driver' }),
		} as never)

		// 2. Fake Unipile client — captures what the send lands with.
		let seenAccountId: string | null = null
		let sendCalls = 0
		__setLinkedInClientForTests(
			() =>
				({
					sendMessage: async (payload: { account_id: string }) => {
						sendCalls++
						seenAccountId = payload.account_id
						return {
							status: 200,
							body: { id: 'msg-driver-1', sent_at: '2026-09-03T10:00:00Z' },
							headers: {},
						}
					},
					reply: async () => ({ status: 200, body: {}, headers: {} }),
					listConversations: async () => ({
						status: 200,
						body: { conversations: [] },
						headers: {},
					}),
				}) as never,
		)

		// 3. Idempotency key — produced by the loop's shared helper.
		const idempotencyKey = buildLinkedinAutosendIdempotencyKey({
			contactId: CONTACT_ID,
			draftId: DRAFT_ID,
		})
		expect(idempotencyKey).toBe(`${CONTACT_ID}:${DRAFT_ID}`)

		// 4. POST /send-message — the Task 3 route the loop hands off to.
		const { rows, db } = buildFakeDb()
		const app = buildApp(DRIVER_ACTOR, db)
		const res = await app.request('/api/integrations/linkedin-unipile/send-message', {
			method: 'POST',
			headers: {
				'x-workspace-id': WORKSPACE_ID,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				recipient_urn: 'urn:li:person:AbC123',
				body: 'Hello from the Sales Rep loop',
				idempotency_key: idempotencyKey,
			}),
		})

		expect(res.status).toBe(200)
		const json = (await res.json()) as { message_id: string; replayed: boolean }
		expect(json.message_id).toBe('msg-driver-1')
		expect(json.replayed).toBe(false)

		// 5. The send actually fired against the driver-actor's account_id.
		expect(sendCalls).toBe(1)
		expect(seenAccountId).toBe('unipile-driver')

		// 6. The idempotency ledger stored the server-scoped key.
		expect(rows).toHaveLength(1)
		expect(rows[0]?.key).toBe(
			`linkedin-unipile:${DRIVER_ACTOR}:POST:/api/integrations/linkedin-unipile/send-message:${CONTACT_ID}:${DRAFT_ID}`,
		)
		expect(rows[0]?.actorId).toBe(DRIVER_ACTOR)
	})
})
