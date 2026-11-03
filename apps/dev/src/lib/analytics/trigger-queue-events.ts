import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

export type TriggerQueueReason = 'trigger_backoff' | 'workspace_suppression' | 'retry_at_x'

export type TriggerQueueDrainSource =
	| 'backoff_lift'
	| 'workspace_unsuppress'
	| 'retry_at_x_arrival'
	| 'sweep'

interface TriggerEventQueuedProps {
	workspaceId: string
	/** Null for a workspace-suppression drop: the row is fanned out per trigger at replay. */
	triggerId: string | null
	eventId: string
	reason: TriggerQueueReason
	replayAfter: Date
}

/**
 * Emitted once per event parked in trigger_event_queue. The bet's Won criteria
 * reconcile this count against trigger_event_replayed within 5% across the
 * 5-day window post-ship (#6 measured directly). Distinct id is the workspace
 * so per-workspace frequency lines up with the flag's rollout scope.
 *
 * Best-effort: a capture failure is swallowed so analytics never blocks the
 * event path.
 */
export async function trackTriggerEventQueued(p: TriggerEventQueuedProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_event_queued', p.workspaceId, {
			workspace_id: p.workspaceId,
			trigger_id: p.triggerId,
			event_id: p.eventId,
			reason: p.reason,
			replay_after: p.replayAfter.toISOString(),
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_event_queued', {
			triggerId: p.triggerId,
			eventId: p.eventId,
			error: String(err),
		})
	}
}

interface TriggerEventReplayedProps {
	workspaceId: string
	triggerId: string | null
	eventId: string
	drainSource: TriggerQueueDrainSource
	/** Seconds between the row's replay_after and the actual replay; 0 when lifted early. */
	lagSeconds: number
}

/**
 * Emitted once per queued row as the drain replays it — the other half of the
 * pair reconciled against trigger_event_queued. Best-effort, never throws.
 */
export async function trackTriggerEventReplayed(p: TriggerEventReplayedProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_event_replayed', p.workspaceId, {
			workspace_id: p.workspaceId,
			trigger_id: p.triggerId,
			event_id: p.eventId,
			drain_source: p.drainSource,
			lag_seconds: p.lagSeconds,
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_event_replayed', {
			triggerId: p.triggerId,
			eventId: p.eventId,
			error: String(err),
		})
	}
}

interface TriggerQueueOverflowProps {
	workspaceId: string
	triggerId: string | null
}

/**
 * Emitted when the queue is at its per-trigger or per-workspace cap and an
 * event is dropped instead of parked. Sits beside the trigger_queue_overflow
 * events row; the name mirrors the Prometheus-style counter in the tech spec
 * (§4.5), same shape as trigger_dispatch_deduped_total. Best-effort, never
 * throws.
 */
export async function trackTriggerQueueOverflow(p: TriggerQueueOverflowProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_queue_overflow_total', p.workspaceId, {
			workspace_id: p.workspaceId,
			trigger_id: p.triggerId,
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_queue_overflow_total', {
			triggerId: p.triggerId,
			error: String(err),
		})
	}
}

interface TriggerCronTickDroppedProps {
	workspaceId: string
	triggerId: string
	backoffUntil: Date
}

/**
 * Emitted when fireCronTrigger skips a tick because the trigger is in backoff.
 * Cron ticks are dropped, not queued (no events row to replay), so this is the
 * loss count that decides whether a coalesced cron replay is worth building.
 * Best-effort, never throws.
 */
export async function trackTriggerCronTickDropped(p: TriggerCronTickDroppedProps): Promise<void> {
	try {
		await capturePosthogEvent('trigger_cron_tick_dropped', p.workspaceId, {
			workspace_id: p.workspaceId,
			trigger_id: p.triggerId,
			backoff_until: p.backoffUntil.toISOString(),
		})
	} catch (err) {
		logger.warn('Failed to emit trigger_cron_tick_dropped', {
			triggerId: p.triggerId,
			error: String(err),
		})
	}
}
