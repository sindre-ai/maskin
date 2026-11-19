import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

// The chain is the thing under test's input: every login rejected, as on 12 Nov. The resolver
// reports it the way the real one does, through onUnusable, and returns null.
const { resolveClaudeMock } = vi.hoisted(() => ({ resolveClaudeMock: vi.fn() }))
vi.mock('../../lib/claude-failover', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/claude-failover')>()),
	resolveClaudeCredentialsWithFailover: resolveClaudeMock,
}))

import {
	LLM_ROUTE_API_KEY,
	LlmCredentialsUnavailableError,
	SubscriptionStillLimitedError,
	resolveLlmRoute,
} from '../../lib/llm-routing'
import { pickRetryAt } from '../../lib/subscription-limit-reset'
import type { WorkspaceSettings } from '../../lib/types'

const RESET = '2026-11-12T08:00:00.000Z'

function settingsWithKey(): WorkspaceSettings {
	return {
		display_names: { insight: 'Insight', bet: 'Bet', task: 'Task' },
		statuses: {},
		field_definitions: {},
		relationship_types: [],
		custom_extensions: {},
		enabled_modules: ['work'],
		max_concurrent_sessions: 3,
		llm_keys: { anthropic: 'sk-ant-ws' },
		claude_oauth: {
			primary: { encryptedAccessToken: 'a', encryptedRefreshToken: 'r', expiresAt: 1 },
			backup: { encryptedAccessToken: 'b', encryptedRefreshToken: 'r', expiresAt: 1 },
		},
	} as unknown as WorkspaceSettings
}

function params(subscriptionOnly?: boolean) {
	return {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		wsSettings: settingsWithKey(),
		enterprise: true,
		agent: {},
		env: {} as NodeJS.ProcessEnv,
		...(subscriptionOnly === undefined ? {} : { subscriptionOnly }),
	}
}

function everyLoginRejected(info: { reason: string; retryAt?: string; transient?: boolean }) {
	resolveClaudeMock.mockImplementation(async ({ onUnusable }) => {
		onUnusable?.({
			transient: info.transient ?? false,
			detail: `the last Claude subscription in the failover chain was also rejected (${info.reason})`,
			reason: info.reason,
			retryAt: info.retryAt,
		})
		return null
	})
}

beforeEach(() => {
	resolveClaudeMock.mockReset()
})

describe('resolveLlmRoute for a retry after a Claude limit', () => {
	it('falls through to the workspace API key on a first run when every login is limited', async () => {
		// The behaviour the retry must not inherit.
		everyLoginRejected({ reason: 'quota_exhausted', retryAt: RESET })
		const result = await resolveLlmRoute(params())
		expect(result?.route).toBe(LLM_ROUTE_API_KEY)
	})

	it('never takes the API key when every login is still limited', async () => {
		everyLoginRejected({ reason: 'quota_exhausted', retryAt: RESET })
		const err = await resolveLlmRoute(params(true)).catch((e) => e)
		expect(err).toBeInstanceOf(SubscriptionStillLimitedError)
	})

	it('reports the limit again with the reset time, so the run is queued for then', async () => {
		everyLoginRejected({ reason: 'quota_exhausted', retryAt: RESET })
		const err = (await resolveLlmRoute(params(true)).catch(
			(e) => e,
		)) as SubscriptionStillLimitedError
		const reason = err.toFailureReason()
		expect(reason).toMatchObject({
			provider: 'anthropic',
			reason_code: 'session_limit',
			reset_at: RESET,
		})
		expect(pickRetryAt(reason, new Date('2026-11-12T05:00:00Z'))?.toISOString()).toBe(RESET)
	})

	it('falls back to the short back-off when the logins gave no reset time', async () => {
		everyLoginRejected({ reason: 'quota_exhausted' })
		const err = (await resolveLlmRoute(params(true)).catch(
			(e) => e,
		)) as SubscriptionStillLimitedError
		const now = new Date('2026-11-12T05:00:00Z')
		expect(pickRetryAt(err.toFailureReason(), now)?.getTime()).toBe(now.getTime() + 30 * 60_000)
	})

	it('does not queue a revoked login for later, and still skips the API key', async () => {
		everyLoginRejected({ reason: 'auth_failed' })
		const err = (await resolveLlmRoute(params(true)).catch(
			(e) => e,
		)) as LlmCredentialsUnavailableError
		expect(err).toBeInstanceOf(LlmCredentialsUnavailableError)
		expect(err).not.toBeInstanceOf(SubscriptionStillLimitedError)
		expect(pickRetryAt(err.toFailureReason())).toBeNull()
	})

	it('keeps a login that is only unreachable transient, so the dispatcher retries it', async () => {
		everyLoginRejected({ reason: 'network_timeout', transient: true })
		const err = (await resolveLlmRoute(params(true)).catch(
			(e) => e,
		)) as LlmCredentialsUnavailableError
		expect(err.transient).toBe(true)
	})

	it('still returns the subscription when one login works', async () => {
		resolveClaudeMock.mockResolvedValue({
			slot: 'backup',
			tokens: { accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000 },
		})
		const result = await resolveLlmRoute(params(true))
		expect(result?.route).toBe('claude_oauth')
	})
})
