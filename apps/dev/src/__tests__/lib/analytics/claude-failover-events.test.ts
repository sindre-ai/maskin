import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	trackClaudeSubscriptionBackupExhausted,
	trackClaudeSubscriptionFailoverTriggered,
	trackClaudeSubscriptionRecovered,
} from '../../../lib/analytics/claude-failover-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackClaudeSubscriptionFailoverTriggered', () => {
	it('emits with workspace as distinct id and the contracted props (session_start trigger)', async () => {
		await trackClaudeSubscriptionFailoverTriggered({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			reason: 'quota_exhausted',
			failureWindow: 1_700_000_000_000,
			trigger: 'session_start',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'claude_subscription_failover_triggered',
			'ws-1',
			{
				workspace_id: 'ws-1',
				actor_id: 'actor-1',
				reason: 'quota_exhausted',
				failure_window: 1_700_000_000_000,
				trigger: 'session_start',
				source_session_id: undefined,
			},
		)
	})

	it('forwards source_session_id for runtime_session_failure trigger', async () => {
		await trackClaudeSubscriptionFailoverTriggered({
			workspaceId: 'ws-2',
			actorId: 'actor-2',
			reason: 'auth_failed',
			failureWindow: 1_700_000_060_000,
			trigger: 'runtime_session_failure',
			sourceSessionId: 'sess-42',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'claude_subscription_failover_triggered',
			'ws-2',
			expect.objectContaining({
				trigger: 'runtime_session_failure',
				source_session_id: 'sess-42',
			}),
		)
	})
})

describe('trackClaudeSubscriptionBackupExhausted', () => {
	it('emits with reason + failure_window + source session', async () => {
		await trackClaudeSubscriptionBackupExhausted({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			reason: 'quota_exhausted',
			failureWindow: 1_700_000_060_000,
			sourceSessionId: 'sess-9',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'claude_subscription_backup_exhausted',
			'ws-1',
			{
				workspace_id: 'ws-1',
				actor_id: 'actor-1',
				reason: 'quota_exhausted',
				failure_window: 1_700_000_060_000,
				source_session_id: 'sess-9',
			},
		)
	})
})

describe('trackClaudeSubscriptionRecovered', () => {
	it('emits with prior failure timestamp + classified reason', async () => {
		await trackClaudeSubscriptionRecovered({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			recoveredAt: 1_700_000_360_000,
			priorFailureAt: 1_700_000_000_000,
			priorFailureReason: 'auth_failed',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('claude_subscription_recovered', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			recovered_at: 1_700_000_360_000,
			prior_failure_at: 1_700_000_000_000,
			prior_failure_reason: 'auth_failed',
		})
	})

	it('handles missing prior failure metadata (fresh state)', async () => {
		await trackClaudeSubscriptionRecovered({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			recoveredAt: 1_700_000_360_000,
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'claude_subscription_recovered',
			'ws-1',
			expect.objectContaining({
				recovered_at: 1_700_000_360_000,
				prior_failure_at: undefined,
				prior_failure_reason: undefined,
			}),
		)
	})
})
