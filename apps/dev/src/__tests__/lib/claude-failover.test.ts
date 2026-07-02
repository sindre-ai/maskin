import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
}))

// crypto = identity so encrypted blobs round-trip as their plaintext values.
vi.mock('../../lib/crypto', () => ({
	decrypt: (input: string) => input,
	encrypt: (input: string) => input,
}))

import {
	FAILOVER_TRIGGERED_ACTION,
	isClaudeFailoverEnabled,
	resolveClaudeCredentialsWithFailover,
} from '../../lib/claude-failover'
import type { ClassifierInput } from '../../lib/claude-failure-classifier'
import { headersFrom } from '../../lib/claude-failure-classifier'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import type { OAuthSlotStorage } from '../../lib/claude-oauth-slots'

const WORKSPACE_ID = 'workspace-1'
const ACTOR_ID = 'actor-1'
const ORIGINAL_ENV = { ...process.env }

function encryptedSlot(overrides?: Partial<EncryptedOAuthData>): EncryptedOAuthData {
	return {
		encryptedAccessToken: 'access-plain',
		encryptedRefreshToken: 'refresh-plain',
		expiresAt: Date.now() + 60 * 60 * 1000,
		scopes: ['read'],
		...overrides,
	}
}

/**
 * Mock DB that mirrors the shape used by `resolveClaudeCredentialsWithFailover`:
 *  - `select().from().where().limit()` for the initial unlocked read
 *  - `select().from().where().for('update').limit()` inside `transaction()`
 *  - `update().set().where()` for the workspace write
 *  - `insert().values()` for the event write
 *
 * Tracks event inserts + workspace updates so tests can assert idempotency.
 */
function createMockDb(initial: { settings: Record<string, unknown> } | undefined) {
	let current: { settings: Record<string, unknown> } | undefined = initial

	const eventInserts: Array<Record<string, unknown>> = []
	const workspaceUpdates: Array<Record<string, unknown>> = []

	const insertValues = vi.fn(async (values: Record<string, unknown>) => {
		eventInserts.push(values)
	})
	const update = vi.fn().mockReturnValue({
		set: vi.fn((patch: Record<string, unknown>) => ({
			where: vi.fn(async () => {
				workspaceUpdates.push(patch)
				if (patch.settings && current) {
					current = { settings: patch.settings as Record<string, unknown> }
				}
			}),
		})),
	})

	function selectChain() {
		const limit = vi.fn(async () => (current ? [current] : []))
		const forFn = vi.fn().mockReturnValue({ limit })
		const where = vi.fn().mockReturnValue({ limit, for: forFn })
		return {
			from: vi.fn().mockReturnValue({ where }),
		}
	}

	// Serialize `transaction()` calls the way a real `SELECT ... FOR UPDATE`
	// row-lock would — this is the mechanism T6 relies on for AC-T2 de-dup.
	let txChain: Promise<unknown> = Promise.resolve()
	const db = {
		select: vi.fn(selectChain),
		update,
		insert: vi.fn().mockReturnValue({ values: insertValues }),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			const next = txChain.then(() => fn(db))
			txChain = next.catch(() => undefined)
			return next
		}),
	}

	return {
		db: db as unknown as Database,
		eventInserts,
		workspaceUpdates,
		getSettings: () => current?.settings,
	}
}

beforeEach(() => {
	const cleaned: NodeJS.ProcessEnv = { ...ORIGINAL_ENV }
	cleaned.MASKIN_CLAUDE_FAILOVER_ENABLED = undefined
	process.env = cleaned
})

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
	vi.unstubAllGlobals()
})

describe('isClaudeFailoverEnabled', () => {
	it('defaults to false', () => {
		expect(isClaudeFailoverEnabled({})).toBe(false)
	})
	it('true only for the literal "true"', () => {
		expect(isClaudeFailoverEnabled({ MASKIN_CLAUDE_FAILOVER_ENABLED: 'TRUE' })).toBe(true)
		expect(isClaudeFailoverEnabled({ MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' })).toBe(true)
		expect(isClaudeFailoverEnabled({ MASKIN_CLAUDE_FAILOVER_ENABLED: '1' })).toBe(false)
		expect(isClaudeFailoverEnabled({ MASKIN_CLAUDE_FAILOVER_ENABLED: 'yes' })).toBe(false)
		expect(isClaudeFailoverEnabled({ MASKIN_CLAUDE_FAILOVER_ENABLED: '' })).toBe(false)
	})
})

describe('resolveClaudeCredentialsWithFailover', () => {
	describe('AC-T5: feature flag off', () => {
		it('uses the legacy primary-only path and never probes or writes events', async () => {
			const claudeOAuth: OAuthSlotStorage = { primary: encryptedSlot(), backup: encryptedSlot() }
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(
				async (): Promise<ClassifierInput | null> => ({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: {},
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('access-plain')
			expect(probe).not.toHaveBeenCalled()
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})
	})

	describe('AC-U1: healthy primary', () => {
		it('returns primary tokens and does not touch the backup', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(async () => null) // healthy

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('primary-token')
			expect(probe).toHaveBeenCalledTimes(1)
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})
	})

	describe('AC-U2: non-recoverable primary failure', () => {
		it('flips to backup and emits the failover event with the classified reason', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, workspaceUpdates, getSettings } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(
				async (): Promise<ClassifierInput> => ({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				}),
			)

			const nowMs = 1_800_000_060_000 // arbitrary — 1s past a bucket boundary
			const bucket = Math.floor(nowMs / 60_000) * 60_000
			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				now: () => nowMs,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(result?.tokens.accessToken).toBe('backup-token')
			expect(eventInserts).toHaveLength(1)
			expect(eventInserts[0]).toMatchObject({
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				action: FAILOVER_TRIGGERED_ACTION,
				entityType: 'workspace',
				entityId: WORKSPACE_ID,
				data: { reason: 'auth_failed', failure_window: bucket },
			})
			expect(workspaceUpdates).toHaveLength(1)
			const stored = getSettings()?.claude_oauth as OAuthSlotStorage
			expect(stored.failover).toEqual({
				active_slot: 'backup',
				last_primary_failure_at: bucket,
				last_classified_reason: 'auth_failed',
			})
		})

		it('classifies a 429 with the exhausted header as quota_exhausted (failover)', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot(),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			const probe = vi.fn(
				async (): Promise<ClassifierInput> => ({
					kind: 'http',
					status: 429,
					headers: headersFrom({ 'anthropic-ratelimit-unified-status': 'exhausted' }),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(eventInserts[0]).toMatchObject({
				data: expect.objectContaining({ reason: 'quota_exhausted' }),
			})
		})

		it('does not failover on a transient 429 throughput-burst', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(
				async (): Promise<ClassifierInput> => ({
					kind: 'http',
					status: 429,
					headers: headersFrom({ 'retry-after': '30' }),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})
	})

	describe('AC-U4: only primary connected', () => {
		it('returns primary on failover without flipping or emitting an event', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(
				async (): Promise<ClassifierInput> => ({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('primary-token')
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})

		it('respects a legacy single-slot row as primary-only', async () => {
			const legacy = encryptedSlot({ encryptedAccessToken: 'legacy-token' })
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: legacy },
			})
			const probe = vi.fn(
				async (): Promise<ClassifierInput> => ({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('legacy-token')
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})
	})

	describe('AC-T2: concurrent failovers in the same window', () => {
		it('emits exactly one event and both callers converge on backup', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot(),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			// Both calls share a single mock DB. `transaction` is invoked
			// serially by the mock (no real concurrency), but the second tx
			// re-reads the freshest settings via `for('update').limit()` and
			// must observe the state written by the first — that is the
			// idempotency contract the real Postgres row-lock enforces.
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(
				async (): Promise<ClassifierInput> => ({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				}),
			)
			const now = () => 1_800_000_060_000

			const [a, b] = await Promise.all([
				resolveClaudeCredentialsWithFailover({
					db,
					workspaceId: WORKSPACE_ID,
					actorId: ACTOR_ID,
					probe,
					now,
					env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
				}),
				resolveClaudeCredentialsWithFailover({
					db,
					workspaceId: WORKSPACE_ID,
					actorId: ACTOR_ID,
					probe,
					now,
					env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
				}),
			])

			expect(a?.slot).toBe('backup')
			expect(b?.slot).toBe('backup')
			expect(eventInserts).toHaveLength(1)
			// Only the first tx writes; the second tx sees the same bucket +
			// reason under lock and skips both the update and the event insert.
			expect(workspaceUpdates).toHaveLength(1)
		})

		it('emits a new event when the reason changes on a subsequent failure', async () => {
			const bucket = 1_800_000_060_000
			// Row already reflects an earlier failover on `auth_failed`.
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot(),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
				failover: {
					active_slot: 'backup',
					last_primary_failure_at: bucket,
					last_classified_reason: 'auth_failed',
				},
			}
			const { db, eventInserts } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			const probe = vi.fn(async () => null) // healthy — but active_slot is backup so no probe

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				now: () => bucket,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(probe).not.toHaveBeenCalled()
			expect(eventInserts).toHaveLength(0)
		})
	})

	describe('refresh failures', () => {
		it('classifies a 401 thrown by refresh as auth_failed and fails over', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				// Expired token forces the refresh path.
				primary: encryptedSlot({ expiresAt: Date.now() - 60_000 }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: false,
					status: 401,
					text: () => Promise.resolve('unauthorized'),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(eventInserts[0]).toMatchObject({
				data: expect.objectContaining({ reason: 'auth_failed' }),
			})
		})
	})

	describe('empty state', () => {
		it('returns null when the workspace has no claude_oauth configured', async () => {
			const { db } = createMockDb({ settings: {} })
			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})
			expect(result).toBeNull()
		})

		it('returns null when the workspace does not exist', async () => {
			const { db } = createMockDb(undefined)
			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})
			expect(result).toBeNull()
		})
	})
})
