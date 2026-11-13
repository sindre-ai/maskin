import { logger } from '../logger'
import { capturePosthogEvent } from './posthog'

/** What woke the driver. The wake and the sweep tasks of "Agents take the lead" share this list. */
export type DriverWakeSource = 'state_change' | 'sweep' | 'heartbeat'

export type DriverWakeReason =
	| 'child_tasks_closed'
	| 'blocker_cleared'
	| 'decision_answered'
	| 'decision_expired'
	| 'status_changed'
	| 'step_overdue'
	| 'no_next_step'
	| 'behind_pace'
	// Heartbeat pre-check: a change since the last run (a comment from someone else or a new
	// insight linked to what the owner drives), the 3-day floor, and nothing due.
	| 'new_evidence'
	| 'floor_reached'
	| 'nothing_due'

/**
 * changed_something / changed_nothing: the woken run ended and did (not) act on the object.
 * skipped_nothing_due: the sweep or heartbeat found nothing due and started no run. For a heartbeat
 *   this also means "would have skipped" while the pre-check is record-only: the run still started.
 * recorded_only: the sweep found the object due but is in its record-only period, so it started no run.
 * dropped_other_mechanism: another mechanism already held the object (a run was on it, a trigger
 * had started one, the same wake had gone out in the hour, a limit refused it), so no run started.
 */
export type DriverWakeOutcome =
	| 'changed_something'
	| 'changed_nothing'
	| 'skipped_nothing_due'
	| 'recorded_only'
	| 'dropped_other_mechanism'

/** Why a wake was dropped. Optional, and only set with dropped_other_mechanism. */
export type DriverWakeDropReason =
	| 'run_in_progress'
	| 'run_already_started'
	| 'rate_limited'
	| 'not_admitted'
	| 'paused'
	| 'flag_off'

export interface DriverWokenProps {
	workspaceId: string
	agentId: string
	source: DriverWakeSource
	reason: DriverWakeReason
	outcome: DriverWakeOutcome
	dropReason?: DriverWakeDropReason
}

/**
 * One event per wake. Ids, counts and categories only: never an object title or comment text.
 * Tier 1 in event-budget.ts, so it is never sampled or capped. Best-effort: a capture failure
 * never blocks the wake.
 */
export async function trackDriverWoken(p: DriverWokenProps): Promise<void> {
	try {
		await capturePosthogEvent('driver_woken', p.agentId, {
			workspace_id: p.workspaceId,
			agent_id: p.agentId,
			source: p.source,
			reason: p.reason,
			outcome: p.outcome,
			drop_reason: p.dropReason ?? null,
		})
	} catch (err) {
		logger.warn('Failed to emit driver_woken', { reason: p.reason, error: String(err) })
	}
}
