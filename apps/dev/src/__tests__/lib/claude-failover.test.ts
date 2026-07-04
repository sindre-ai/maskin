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

// PostHog forwarding — stubbed so tests never actually hit the network,
// and so we can assert the wrapper is called with the same reason +
// failure_window that lands on the internal event. All three trackers are
// stubbed because `attemptPrimaryRecovery` (invoked by the T7 recovery
// branch) reaches into `trackClaudeSubscriptionRecovered` too.
const { trackFailoverTriggeredMock, trackBackupExhaustedMock, trackRecoveredMock } = vi.hoisted(
	() => ({
		trackFailoverTriggeredMock: vi.fn().mockResolvedValue(undefined),
		trackBackupExhaustedMock: vi.fn().mockResolvedValue(undefined),
		trackRecoveredMock: vi.fn().mockResolvedValue(undefined),
	}),
)
vi.mock('../../lib/analytics/claude-failover-events', () => ({
	trackClaudeSubscriptionFailoverTriggered: trackFailoverTriggeredMock,
	trackClaudeSubscriptionBackupExhausted: trackBackupExhaustedMock,
	trackClaudeSubscriptionRecovered: trackRecoveredMock,
}))

import {
	BACKUP_EXHAUSTED_ACTION,
	FAILOVER_TRIGGERED_ACTION,
	isClaudeFailoverEnabled,
	resolveClaudeCredentialsWithFailover,
} from '../../lib/claude-failover'
import type { ClassifierInput } from '../../lib/claude-failure-classifier'
import { headersFrom } from '../../lib/claude-failure-classifier'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import { PRIMARY_RECOVERY_COOLDOWN_MS } from '../../lib/claude-oauth-recovery'
import type { OAuthSlotStorage } from '../../lib/claude-oauth-slots'

const WORKSPACE_ID = 'workspace-1'
const ACTOR_ID = 'actor-1'

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
		// `attemptPrimaryRecovery` (T7) locks the row via a raw `tx.execute(sql\`...
		// FOR UPDATE\`)` instead of the `.select().for('update')` chain — mirror
		// its result shape here. drizzle-orm/postgres-js's `.execute()` returns
		// the row list directly (no `{ rows: [...] }` wrapper — that's a
		// node-postgres/`pg`-specific shape).
		execute: vi.fn(async () => (current ? [current] : [])),
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
	// Every test below passes `env` explicitly to
	// `resolveClaudeCredentialsWithFailover`, so this is just a safety net in
	// case a future test forgets to. Use `vi.stubEnv`/`unstubAllEnvs` (scoped,
	// tracked restoration of just this key) rather than reassigning
	// `process.env` wholesale — a full reassignment across a `beforeEach` /
	// `afterEach` pair mutates the single process-wide `process.env` object
	// other test files share, and can clobber env vars another file's test
	// set up concurrently.
	vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', '')
	trackFailoverTriggeredMock.mockClear()
	trackBackupExhaustedMock.mockClear()
	trackRecoveredMock.mockClear()
})

afterEach(() => {
	vi.unstubAllEnvs()
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
			// AC-T5: flag off ⇒ no PostHog forwarding either.
			expect(trackFailoverTriggeredMock).not.toHaveBeenCalled()
		})

		it('forces primary-only routing even when active_slot was persisted as backup', async () => {
			// Disabling the flag is meant to work as an incident kill-switch —
			// it must not keep silently serving backup tokens (mislabeled as
			// primary) just because an earlier flag-on failover flipped
			// active_slot.
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
				failover: {
					active_slot: 'backup',
					last_primary_failure_at: 1_700_000_000_000,
					last_classified_reason: 'auth_failed',
				},
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: {},
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('primary-token')
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})

		describe('refresh failures', () => {
			it('returns null on a permanent (401) refresh failure instead of serving a doomed stale token', async () => {
				// Regression test: the flag-off path used to swallow ANY refresh
				// error and hand back the pre-refresh token as "success" as long
				// as it hadn't literally expired yet — including a revoked
				// refresh token (401/invalid_grant), which can never succeed
				// again. That skipped llm-routing's fallback to the workspace
				// API key / system routes and launched a session doomed to fail.
				const claudeOAuth: OAuthSlotStorage = {
					primary: encryptedSlot({
						expiresAt: Date.now() + 5 * 60 * 1000,
						encryptedAccessToken: 'still-valid-primary-token',
					}),
				}
				const { db } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
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
					env: {},
				})

				expect(result).toBeNull()
			})

			it('still returns the stale primary on a transient (5xx) refresh failure when not yet expired', async () => {
				// Transient failures are still safe to swallow — this preserves
				// the flag-off path's existing lenient behaviour for blips.
				const claudeOAuth: OAuthSlotStorage = {
					primary: encryptedSlot({
						expiresAt: Date.now() + 5 * 60 * 1000,
						encryptedAccessToken: 'still-valid-primary-token',
					}),
				}
				const { db } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
				vi.stubGlobal(
					'fetch',
					vi.fn().mockResolvedValue({
						ok: false,
						status: 503,
						text: () => Promise.resolve('service unavailable'),
					}),
				)

				const result = await resolveClaudeCredentialsWithFailover({
					db,
					workspaceId: WORKSPACE_ID,
					actorId: ACTOR_ID,
					env: {},
				})

				expect(result?.slot).toBe('primary')
				expect(result?.tokens.accessToken).toBe('still-valid-primary-token')
			})

			it('returns null on a transient (5xx) refresh failure when the token has actually expired', async () => {
				const claudeOAuth: OAuthSlotStorage = {
					primary: encryptedSlot({
						expiresAt: Date.now() - 60_000,
						encryptedAccessToken: 'stale-primary-token',
					}),
				}
				const { db } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
				vi.stubGlobal(
					'fetch',
					vi.fn().mockResolvedValue({
						ok: false,
						status: 503,
						text: () => Promise.resolve('service unavailable'),
					}),
				)

				const result = await resolveClaudeCredentialsWithFailover({
					db,
					workspaceId: WORKSPACE_ID,
					actorId: ACTOR_ID,
					env: {},
				})

				expect(result).toBeNull()
			})
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
			const probe = vi
				.fn<() => Promise<ClassifierInput | null>>()
				.mockResolvedValueOnce({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				})
				.mockResolvedValueOnce(null)

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
			// PostHog forwarding: exactly one capture, same reason +
			// failure_window as the internal event.
			expect(trackFailoverTriggeredMock).toHaveBeenCalledOnce()
			expect(trackFailoverTriggeredMock).toHaveBeenCalledWith({
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				reason: 'auth_failed',
				failureWindow: bucket,
				trigger: 'session_start',
			})
		})

		it('classifies a 429 with the exhausted header as quota_exhausted (failover)', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot(),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			const probe = vi
				.fn<() => Promise<ClassifierInput | null>>()
				.mockResolvedValueOnce({
					kind: 'http',
					status: 429,
					headers: headersFrom({ 'anthropic-ratelimit-unified-status': 'exhausted' }),
				})
				.mockResolvedValueOnce(null)

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

		it('returns null and records backup exhaustion when the backup probe also fails', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, getSettings } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi
				.fn<() => Promise<ClassifierInput | null>>()
				.mockResolvedValueOnce({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				})
				.mockResolvedValueOnce({
					kind: 'http',
					status: 429,
					headers: headersFrom({ 'anthropic-ratelimit-unified-status': 'exhausted' }),
				})

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result).toBeNull()
			expect(eventInserts.map((event) => event.action)).toEqual([
				FAILOVER_TRIGGERED_ACTION,
				BACKUP_EXHAUSTED_ACTION,
			])
			const stored = getSettings()?.claude_oauth as OAuthSlotStorage
			expect(stored.failover).toMatchObject({
				active_slot: 'backup',
				last_classified_reason: 'auth_failed',
				last_backup_classified_reason: 'quota_exhausted',
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
			const probe = vi
				.fn<() => Promise<ClassifierInput | null>>()
				.mockResolvedValueOnce({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				})
				.mockResolvedValueOnce({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				})
				.mockResolvedValue(null)
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
			// PostHog forwarding must match the internal-event dedup exactly —
			// the losing contender skips the capture too.
			expect(trackFailoverTriggeredMock).toHaveBeenCalledOnce()
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
			const probe = vi.fn(async () => null) // healthy backup probe

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				now: () => bucket,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(probe).toHaveBeenCalledTimes(1)
			expect(eventInserts).toHaveLength(0)
		})
	})

	describe('AC-U6: lazy primary recovery (T7)', () => {
		it('flips back to primary once the cooldown has elapsed and the probe succeeds', async () => {
			const lastFailure = 1_700_000_000_000
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'recovered-primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
				failover: {
					active_slot: 'backup',
					last_primary_failure_at: lastFailure,
					last_classified_reason: 'auth_failed',
				},
			}
			const { db, eventInserts, getSettings } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi.fn(async () => null) // primary is healthy again

			const now = lastFailure + PRIMARY_RECOVERY_COOLDOWN_MS + 1
			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				now: () => now,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('recovered-primary-token')
			expect(probe).toHaveBeenCalledTimes(1)
			const stored = getSettings()?.claude_oauth as OAuthSlotStorage
			expect(stored.failover).toEqual({ active_slot: 'primary' })
			expect(eventInserts).toHaveLength(1)
			expect(eventInserts[0]).toMatchObject({ action: 'claude_subscription_recovered' })
		})

		it('stays on backup and records the new failure reason when the recovery probe still fails', async () => {
			const lastFailure = 1_700_000_000_000
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'still-broken-primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
				failover: {
					active_slot: 'backup',
					last_primary_failure_at: lastFailure,
					last_classified_reason: 'auth_failed',
				},
			}
			const { db, eventInserts, getSettings } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			const probe = vi
				.fn<() => Promise<ClassifierInput | null>>()
				.mockResolvedValueOnce({
					kind: 'http',
					status: 401,
					headers: headersFrom({}),
				})
				.mockResolvedValueOnce(null)

			const now = lastFailure + PRIMARY_RECOVERY_COOLDOWN_MS + 1
			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				now: () => now,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(result?.tokens.accessToken).toBe('backup-token')
			const stored = getSettings()?.claude_oauth as OAuthSlotStorage
			expect(stored.failover?.active_slot).toBe('backup')
			expect(stored.failover?.last_primary_failure_at).toBe(now)
			expect(stored.failover?.last_classified_reason).toBe('auth_failed')
			expect(eventInserts).toHaveLength(0)
		})

		it('does not attempt recovery before the cooldown has elapsed', async () => {
			const lastFailure = 1_700_000_000_000
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
				failover: {
					active_slot: 'backup',
					last_primary_failure_at: lastFailure,
					last_classified_reason: 'auth_failed',
				},
			}
			const { db, workspaceUpdates } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			const probe = vi.fn(async () => null)

			const now = lastFailure + 1000 // well within the 5-minute cooldown
			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				probe,
				now: () => now,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('backup')
			expect(probe).toHaveBeenCalledTimes(1)
			expect(workspaceUpdates).toHaveLength(0)
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
				vi
					.fn()
					.mockResolvedValueOnce({
						ok: false,
						status: 401,
						text: () => Promise.resolve('unauthorized'),
					})
					.mockResolvedValueOnce({ ok: true, headers: new Headers() }),
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

		it('classifies a 400 invalid_grant thrown by refresh as auth_failed and fails over', async () => {
			// The OAuth token endpoint returns 400 (not 401) for a revoked/expired
			// refresh token — this must land on the same auth_failed bucket as a
			// live 401, not the classifier's generic server_error default.
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ expiresAt: Date.now() - 60_000 }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			vi.stubGlobal(
				'fetch',
				vi
					.fn()
					.mockResolvedValueOnce({
						ok: false,
						status: 400,
						text: () => Promise.resolve('{"error":"invalid_grant"}'),
					})
					.mockResolvedValueOnce({ ok: true, headers: new Headers() }),
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

		it('returns null (not a stale token) on a 5xx thrown by refresh when the token is actually expired', async () => {
			// The proactive refresh buffer already meant this token *would*
			// still work for a few more minutes in the common case — but here
			// `expiresAt` is genuinely in the past, so handing it back as
			// "success" would launch a session with a dead token instead of
			// letting the caller (llm-routing) fall through to the workspace
			// API key / system fallback routes.
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({
					expiresAt: Date.now() - 60_000,
					encryptedAccessToken: 'stale-primary-token',
				}),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: false,
					status: 503,
					text: () => Promise.resolve('service unavailable'),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result).toBeNull()
			// Not a failover verdict — this is retry_primary, so no backup flip.
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})

		it('still returns the primary on a 5xx thrown by refresh when the token has not actually expired yet', async () => {
			// Proactive refresh (10-minute buffer) attempted early and hit a
			// transient 503, but the token itself is still genuinely valid for
			// a few more minutes — safe to keep using rather than force a
			// fallback route switch for a non-issue.
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({
					expiresAt: Date.now() + 2 * 60 * 1000,
					encryptedAccessToken: 'still-valid-primary-token',
				}),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue({
					ok: false,
					status: 503,
					text: () => Promise.resolve('service unavailable'),
				}),
			)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(result?.tokens.accessToken).toBe('still-valid-primary-token')
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
		})
	})

	describe('default probe wiring', () => {
		it('falls back to the real Anthropic Messages API probe when none is injected', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts } = createMockDb({ settings: { claude_oauth: claudeOAuth } })
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 401,
					headers: new Headers(),
				})
				.mockResolvedValueOnce({ ok: true, headers: new Headers() })
			vi.stubGlobal('fetch', fetchMock)

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
				// No `probe` override — must default to a real probe instead of
				// silently treating the primary as healthy.
			})

			expect(fetchMock).toHaveBeenCalledWith(
				expect.stringContaining('/v1/messages'),
				expect.objectContaining({
					headers: expect.objectContaining({ Authorization: 'Bearer primary-token' }),
				}),
			)
			expect(result?.slot).toBe('backup')
			expect(eventInserts[0]).toMatchObject({
				data: expect.objectContaining({ reason: 'auth_failed' }),
			})
		})

		it('returns primary unchanged when the default probe succeeds', async () => {
			const claudeOAuth: OAuthSlotStorage = {
				primary: encryptedSlot({ encryptedAccessToken: 'primary-token' }),
				backup: encryptedSlot({ encryptedAccessToken: 'backup-token' }),
			}
			const { db, eventInserts, workspaceUpdates } = createMockDb({
				settings: { claude_oauth: claudeOAuth },
			})
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: new Headers() }))

			const result = await resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: WORKSPACE_ID,
				actorId: ACTOR_ID,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			})

			expect(result?.slot).toBe('primary')
			expect(eventInserts).toHaveLength(0)
			expect(workspaceUpdates).toHaveLength(0)
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
