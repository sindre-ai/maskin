import { capturePosthogEvent } from './posthog'

// Server-side PostHog emitters for the Claude subscription failover bet's
// ship metric. The internal `events` table insert is still the source of
// truth (audit + SSE real-time); this forwards a copy to PostHog so the
// bet's `metadata.posthog_query` dashboards actually see traffic. Each
// track fn wraps a single `capturePosthogEvent` call following the same
// pattern as `catalog-events.ts`.
//
// `capturePosthogEvent` is best-effort and never throws — see `posthog.ts`.
// Callers should invoke these AFTER the internal event insert's
// transaction has committed so the row lock isn't held across the network
// fetch to PostHog.

interface FailoverTriggeredProps {
	workspaceId: string
	actorId: string
	reason: string
	failureWindow: number
	trigger?: 'session_start' | 'runtime_session_failure'
	sourceSessionId?: string
}

export async function trackClaudeSubscriptionFailoverTriggered(
	p: FailoverTriggeredProps,
): Promise<void> {
	await capturePosthogEvent('claude_subscription_failover_triggered', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		reason: p.reason,
		failure_window: p.failureWindow,
		trigger: p.trigger,
		source_session_id: p.sourceSessionId,
	})
}

interface BackupExhaustedProps {
	workspaceId: string
	actorId: string
	reason: string
	failureWindow: number
	sourceSessionId?: string
}

export async function trackClaudeSubscriptionBackupExhausted(
	p: BackupExhaustedProps,
): Promise<void> {
	await capturePosthogEvent('claude_subscription_backup_exhausted', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		reason: p.reason,
		failure_window: p.failureWindow,
		source_session_id: p.sourceSessionId,
	})
}

interface RecoveredProps {
	workspaceId: string
	actorId: string
	recoveredAt: number
	priorFailureAt?: number
	priorFailureReason?: string
}

export async function trackClaudeSubscriptionRecovered(p: RecoveredProps): Promise<void> {
	await capturePosthogEvent('claude_subscription_recovered', p.workspaceId, {
		workspace_id: p.workspaceId,
		actor_id: p.actorId,
		recovered_at: p.recoveredAt,
		prior_failure_at: p.priorFailureAt,
		prior_failure_reason: p.priorFailureReason,
	})
}
