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

vi.mock('../../lib/analytics/claude-failover-events', () => ({
	trackClaudeSubscriptionFailoverTriggered: vi.fn().mockResolvedValue(undefined),
	trackClaudeSubscriptionBackupExhausted: vi.fn().mockResolvedValue(undefined),
	trackClaudeSubscriptionRecovered: vi.fn().mockResolvedValue(undefined),
}))

import {
	SESSION_OAUTH_EXPIRES_AT_KEY,
	isAuthErrorAtAccessTokenExpiry,
	resolveClaudeCredentialsWithFailover,
} from '../../lib/claude-failover'
import {
	CLAUDE_LAUNCH_BUFFER_ENV,
	CLAUDE_PLATFORM_REFRESH_FLAG_ENV,
	DEFAULT_CLAUDE_LAUNCH_BUFFER_MS,
	type EncryptedOAuthData,
	isClaudePlatformRefreshEnabled,
	readClaudeLaunchBufferMs,
	resetClaudeSlotLifetimes,
} from '../../lib/claude-oauth'
import type { OAuthSlotStorage } from '../../lib/claude-oauth-slots'
import { resolveLlmRoute } from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const WORKSPACE_ID = 'workspace-launch'
const ACTOR_ID = 'actor-1'
const FAILOVER_ON = { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' }
const LAUNCH_3H = { launchMs: 3 * HOUR }
const FLAG_ON = { MASKIN_CLAUDE_PLATFORM_REFRESH_ENABLED: 'true' }

function slot(overrides?: Partial<EncryptedOAuthData>): EncryptedOAuthData {
	return {
		encryptedAccessToken: 'access-1',
		encryptedRefreshToken: 'refresh-1',
		expiresAt: Date.now() + 7 * HOUR,
		scopes: ['read'],
		...overrides,
	}
}

/**
 * Same mock DB shape as claude-failover.test.ts: a workspace row read through
 * select().from().where().limit() and written inside a serialised transaction.
 */
function createMockDb(initial: { settings: Record<string, unknown> }) {
	let current = initial
	const eventInserts: Array<Record<string, unknown>> = []
	const update = vi.fn().mockReturnValue({
		set: vi.fn((patch: Record<string, unknown>) => ({
			where: vi.fn(async () => {
				if (patch.settings) current = { settings: patch.settings as Record<string, unknown> }
			}),
		})),
	})
	function selectChain() {
		const limit = vi.fn(async () => [current])
		const forFn = vi.fn().mockReturnValue({ limit })
		const where = vi.fn().mockReturnValue({ limit, for: forFn })
		return { from: vi.fn().mockReturnValue({ where }) }
	}
	let txChain: Promise<unknown> = Promise.resolve()
	const db = {
		select: vi.fn(selectChain),
		update,
		insert: vi.fn().mockReturnValue({
			values: vi.fn(async (values: Record<string, unknown>) => {
				eventInserts.push(values)
			}),
		}),
		execute: vi.fn(async () => [current]),
		transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
			const next = txChain.then(() => fn(db))
			txChain = next.catch(() => undefined)
			return next
		}),
	}
	return {
		db: db as unknown as Database,
		eventInserts,
		getClaudeOAuth: () => current.settings.claude_oauth as OAuthSlotStorage,
	}
}

/** Token endpoint that rotates its refresh token and answers with a given lifetime. */
function tokenEndpoint(expiresInSeconds: number) {
	let n = 1
	return vi.fn(async (_url: string, _init: { body: string }) => {
		await new Promise((resolve) => setTimeout(resolve, 5))
		n += 1
		return {
			ok: true,
			json: async () => ({
				access_token: `access-${n}`,
				refresh_token: `refresh-${n}`,
				expires_in: expiresInSeconds,
			}),
		}
	})
}

function launch(db: Database, extra?: { now?: () => number }) {
	return resolveClaudeCredentialsWithFailover({
		db,
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		probe: async () => null,
		env: FAILOVER_ON,
		bufferMs: LAUNCH_3H,
		...extra,
	})
}

beforeEach(() => {
	resetClaudeSlotLifetimes()
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('launch buffer settings', () => {
	it('is off unless the flag is the literal string true', () => {
		expect(isClaudePlatformRefreshEnabled({})).toBe(false)
		expect(isClaudePlatformRefreshEnabled({ [CLAUDE_PLATFORM_REFRESH_FLAG_ENV]: 'false' })).toBe(
			false,
		)
		expect(isClaudePlatformRefreshEnabled({ [CLAUDE_PLATFORM_REFRESH_FLAG_ENV]: '1' })).toBe(false)
		expect(isClaudePlatformRefreshEnabled({ [CLAUDE_PLATFORM_REFRESH_FLAG_ENV]: ' True ' })).toBe(
			true,
		)
	})

	it('defaults to 3 hours and reads the setting when it is a positive number', () => {
		expect(DEFAULT_CLAUDE_LAUNCH_BUFFER_MS).toBe(10_800_000)
		expect(readClaudeLaunchBufferMs({})).toBe(10_800_000)
		expect(readClaudeLaunchBufferMs({ [CLAUDE_LAUNCH_BUFFER_ENV]: '7200000' })).toBe(7_200_000)
	})

	it.each(['abc', '', '0', '-5', 'Infinity'])('falls back to the default for %j', (raw) => {
		expect(readClaudeLaunchBufferMs({ [CLAUDE_LAUNCH_BUFFER_ENV]: raw })).toBe(
			DEFAULT_CLAUDE_LAUNCH_BUFFER_MS,
		)
	})
})

describe('launch refresh policy', () => {
	it.each([
		{ lifetimeH: 8, effectiveH: 3 },
		{ lifetimeH: 5, effectiveH: 2.5 },
		{ lifetimeH: 4.5, effectiveH: 2.25 },
	])(
		'caps the effective buffer at $effectiveH h for a $lifetimeH h token',
		async ({ lifetimeH, effectiveH }) => {
			const { db } = createMockDb({
				settings: { claude_oauth: { primary: slot() } satisfies OAuthSlotStorage },
			})
			const fetchMock = tokenEndpoint(lifetimeH * 3600)
			vi.stubGlobal('fetch', fetchMock)
			vi.useFakeTimers({ toFake: ['Date'] })
			const start = Date.now()

			// First launch: lifetime unknown, so one forced refresh teaches it.
			await launch(db)
			expect(fetchMock).toHaveBeenCalledTimes(1)

			// Just outside the effective buffer: the stored token is used as is.
			vi.setSystemTime(start + lifetimeH * HOUR - effectiveH * HOUR - MINUTE)
			await launch(db)
			expect(fetchMock).toHaveBeenCalledTimes(1)

			// Just inside it: refreshed.
			vi.setSystemTime(start + lifetimeH * HOUR - effectiveH * HOUR + MINUTE)
			await launch(db)
			expect(fetchMock).toHaveBeenCalledTimes(2)
		},
	)

	it('refreshes a slot with unknown lifetime exactly once, not on every launch, and not at the 10 minute buffer', async () => {
		// 7 h left is far outside the old 10 minute buffer, so only the forced
		// refresh can explain a POST here.
		const { db, getClaudeOAuth } = createMockDb({
			settings: { claude_oauth: { primary: slot() } satisfies OAuthSlotStorage },
		})
		const fetchMock = tokenEndpoint(8 * 3600)
		vi.stubGlobal('fetch', fetchMock)

		const first = await launch(db)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(first?.tokens.accessToken).toBe('access-2')
		expect(getClaudeOAuth().primary?.encryptedRefreshToken).toBe('refresh-2')

		// Second launch on the same slot: lifetime now known, 8 h left, no POST.
		const second = await launch(db)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(second?.tokens.accessToken).toBe('access-2')
	})

	it('sends one POST for two parallel launches on a slot with unknown lifetime', async () => {
		const { db } = createMockDb({
			settings: { claude_oauth: { primary: slot() } satisfies OAuthSlotStorage },
		})
		const fetchMock = tokenEndpoint(8 * 3600)
		vi.stubGlobal('fetch', fetchMock)

		const [a, b] = await Promise.all([launch(db), launch(db)])

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(a?.tokens.accessToken).toBe('access-2')
		expect(b?.tokens.accessToken).toBe('access-2')
	})

	it('hands back a token that outlives the 2 hour session cap', async () => {
		const { db } = createMockDb({
			// 1 h left: inside the 3 h buffer, but the lifetime is unknown anyway.
			settings: {
				claude_oauth: {
					primary: slot({ expiresAt: Date.now() + HOUR }),
				} satisfies OAuthSlotStorage,
			},
		})
		vi.stubGlobal('fetch', tokenEndpoint(8 * 3600))

		const result = await launch(db)

		expect(result?.tokens.expiresAt).toBeGreaterThan(Date.now() + 3 * HOUR)
	})

	it('takes the slot-failure path once, with no retry, when the forced refresh fails', async () => {
		const { db, eventInserts } = createMockDb({
			settings: {
				claude_oauth: {
					primary: slot(),
					backup: slot({
						encryptedAccessToken: 'backup-access',
						encryptedRefreshToken: 'backup-refresh',
					}),
				} satisfies OAuthSlotStorage,
			},
		})
		const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
			const { refresh_token } = JSON.parse(init.body)
			if (refresh_token === 'refresh-1') {
				return { ok: false, status: 400, text: async () => 'invalid_grant' }
			}
			return {
				ok: true,
				json: async () => ({ access_token: 'backup-access-2', expires_in: 8 * 3600 }),
			}
		})
		vi.stubGlobal('fetch', fetchMock)

		const result = await launch(db)

		const primaryPosts = fetchMock.mock.calls.filter(
			([, init]) => JSON.parse(init.body).refresh_token === 'refresh-1',
		)
		expect(primaryPosts).toHaveLength(1)
		expect(result?.slot).toBe('backup')
		expect(eventInserts).toHaveLength(1)
		expect(eventInserts[0]).toMatchObject({
			data: expect.objectContaining({ reason: 'auth_failed' }),
		})
	})

	it('does not refresh a healthy slot when the policy is the old fixed buffer', async () => {
		const { db } = createMockDb({
			settings: { claude_oauth: { primary: slot({ expiresAt: Date.now() + HOUR }) } },
		})
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)

		const result = await resolveClaudeCredentialsWithFailover({
			db,
			workspaceId: WORKSPACE_ID,
			actorId: ACTOR_ID,
			probe: async () => null,
			env: FAILOVER_ON,
		})

		expect(fetchMock).not.toHaveBeenCalled()
		expect(result?.tokens.accessToken).toBe('access-1')
	})
})

describe('resolveLlmRoute env for the container', () => {
	const settings = {
		display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
		statuses: {},
		field_definitions: {},
		relationship_types: [],
		custom_extensions: {},
		enabled_modules: ['work'],
		max_concurrent_sessions: 3,
		llm_keys: {},
	} as WorkspaceSettings

	function route(db: Database, env: NodeJS.ProcessEnv) {
		return resolveLlmRoute({
			db,
			workspaceId: WORKSPACE_ID,
			actorId: ACTOR_ID,
			wsSettings: settings,
			enterprise: true,
			agent: {},
			claudeProbe: async () => null,
			env,
		})
	}

	it('flag on: the container gets an access token and no refresh token, and the expiry is reported', async () => {
		const { db } = createMockDb({
			settings: { claude_oauth: { primary: slot() } satisfies OAuthSlotStorage },
		})
		vi.stubGlobal('fetch', tokenEndpoint(8 * 3600))

		const result = await route(db, FLAG_ON)

		expect(result?.envVars.CLAUDE_OAUTH_ACCESS_TOKEN).toBe('access-2')
		expect(Object.keys(result?.envVars ?? {})).not.toContain('CLAUDE_OAUTH_REFRESH_TOKEN')
		expect(JSON.stringify(result?.envVars)).not.toContain('refresh-')
		expect(result?.oauthExpiresAt).toBe(Number(result?.envVars.CLAUDE_OAUTH_EXPIRES_AT))
	})

	it('flag on: honours CLAUDE_LAUNCH_BUFFER_MS from the env it is given', async () => {
		const { db } = createMockDb({
			settings: { claude_oauth: { primary: slot() } satisfies OAuthSlotStorage },
		})
		const fetchMock = tokenEndpoint(8 * 3600)
		vi.stubGlobal('fetch', fetchMock)
		await route(db, FLAG_ON) // learns the 8 h lifetime, token now has about 8 h left

		// 1 h buffer: 8 h left is outside it. 9 h buffer is capped at half of 8 h = 4 h, still outside.
		await route(db, { ...FLAG_ON, [CLAUDE_LAUNCH_BUFFER_ENV]: String(HOUR) })
		await route(db, { ...FLAG_ON, [CLAUDE_LAUNCH_BUFFER_ENV]: String(9 * HOUR) })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it.each([
		['unset (the default)', {}],
		['false', { [CLAUDE_PLATFORM_REFRESH_FLAG_ENV]: 'false' }],
	])(
		'flag off, %s: env is exactly today (refresh token present, no refresh, no expiry stamp)',
		async (_label, flagEnv) => {
			const expiresAt = Date.now() + HOUR
			const { db } = createMockDb({
				settings: {
					claude_oauth: {
						primary: slot({ expiresAt, scopes: ['read'], subscriptionType: 'pro' }),
					} satisfies OAuthSlotStorage,
				},
			})
			const fetchMock = vi.fn()
			vi.stubGlobal('fetch', fetchMock)

			const result = await route(db, flagEnv)

			expect(fetchMock).not.toHaveBeenCalled()
			expect(result?.envVars).toEqual({
				CLAUDE_OAUTH_ACCESS_TOKEN: 'access-1',
				CLAUDE_OAUTH_REFRESH_TOKEN: 'refresh-1',
				CLAUDE_OAUTH_EXPIRES_AT: String(expiresAt),
				CLAUDE_OAUTH_SCOPES: '["read"]',
				CLAUDE_OAUTH_SUBSCRIPTION_TYPE: 'pro',
				ANTHROPIC_MODEL: expect.any(String),
				MASKIN_CLAUDE_EFFORT: expect.any(String),
			})
			expect(Object.keys(result?.envVars ?? {}).slice(0, 3)).toEqual([
				'CLAUDE_OAUTH_ACCESS_TOKEN',
				'CLAUDE_OAUTH_REFRESH_TOKEN',
				'CLAUDE_OAUTH_EXPIRES_AT',
			])
			expect(result?.oauthExpiresAt).toBeUndefined()
		},
	)
})

describe('isAuthErrorAtAccessTokenExpiry', () => {
	const expiresAt = 1_800_000_000_000
	const config = { [SESSION_OAUTH_EXPIRES_AT_KEY]: expiresAt }

	it.each(['auth_failed', 'not_logged_in', 'oauth_revoked'])(
		'matches %s once the access token has expired',
		(reason) => {
			expect(isAuthErrorAtAccessTokenExpiry(config, reason, expiresAt + 5 * MINUTE)).toBe(true)
		},
	)

	it('matches within a minute before expiry (clock slack) but not an hour before', () => {
		expect(isAuthErrorAtAccessTokenExpiry(config, 'auth_failed', expiresAt - 30_000)).toBe(true)
		expect(isAuthErrorAtAccessTokenExpiry(config, 'auth_failed', expiresAt - HOUR)).toBe(false)
	})

	it('never matches a usage-limit reason', () => {
		expect(isAuthErrorAtAccessTokenExpiry(config, 'quota_exhausted_5h', expiresAt + MINUTE)).toBe(
			false,
		)
	})

	it('never matches a session that carries no expiry stamp (flag off, other routes)', () => {
		expect(isAuthErrorAtAccessTokenExpiry({}, 'auth_failed', expiresAt + MINUTE)).toBe(false)
		expect(
			isAuthErrorAtAccessTokenExpiry({ [SESSION_OAUTH_EXPIRES_AT_KEY]: 'x' }, 'auth_failed', 1),
		).toBe(false)
	})
})
