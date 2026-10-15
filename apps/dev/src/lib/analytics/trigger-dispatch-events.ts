import { capturePosthogEvent } from './posthog'

interface TriggerDispatchDedupedProps {
	workspaceId: string
	triggerId: string
	eventId: string
}

/**
 * Emitted when the trigger-runner's idempotency guard (trigger_dispatches
 * INSERT ... ON CONFLICT DO NOTHING) skips a dispatch because another
 * instance already claimed the (trigger_id, event_id) pair. In a
 * healthy single-instance deploy this event should be absent; a non-zero
 * rate is the observable signature of blue-green overlap (or future
 * horizontal scale) doing exactly what the table exists to catch.
 *
 * The name `trigger_dispatch_deduped_total` mirrors the Prometheus-style
 * counter name used in the tech spec (§3.4). Backend telemetry only —
 * the dispatch decision has already happened by the time this fires.
 *
 * Best-effort per capturePosthogEvent — never throws.
 */
export async function trackTriggerDispatchDeduped(p: TriggerDispatchDedupedProps): Promise<void> {
	await capturePosthogEvent('trigger_dispatch_deduped_total', p.workspaceId, {
		workspace_id: p.workspaceId,
		trigger_id: p.triggerId,
		event_id: p.eventId,
	})
}
