import { trackSlackTriggerResumedFromAutoPause } from '@/lib/analytics'
import type { TriggerResponse } from '@/lib/api'
import { useUpdateTrigger } from './use-triggers'

/**
 * Shape of `trigger.metadata.auto_paused` stamped by PR C's
 * `handleMemberLeftChannel` webhook handler when Maskin's bot is kicked from
 * a channel a trigger listens on. Kept in sync with the interface in
 * `slack-trigger-setup-status.tsx` — the frontend defensively narrows the
 * shape rather than importing a server-only type, so a schema drift degrades
 * to "no red banner / no branched label" instead of a hard render error.
 */
export interface AutoPausedInfo {
	reason: 'slack_member_left'
	channel_id: string
	paused_at: string
	previous_enabled: boolean
}

/**
 * Narrowing reader for `trigger.metadata.auto_paused`. Only recognises the
 * `slack_member_left` reason; anything else falls through as `null` so the
 * label + banner logic degrades to the user-paused shape rather than
 * mis-rendering. Duplicated (not imported) from `slack-trigger-setup-status`
 * — a ~10-line pure function is cheaper than the cross-file import graph.
 */
export function readAutoPausedInfo(
	trigger: TriggerResponse | null | undefined,
): AutoPausedInfo | null {
	if (!trigger) return null
	const md = trigger.metadata as Record<string, unknown> | null | undefined
	const raw = md?.auto_paused as Record<string, unknown> | undefined
	if (!raw) return null
	if (raw.reason !== 'slack_member_left') return null
	if (typeof raw.channel_id !== 'string' || raw.channel_id.length === 0) return null
	if (typeof raw.paused_at !== 'string') return null
	return {
		reason: 'slack_member_left',
		channel_id: raw.channel_id,
		paused_at: raw.paused_at,
		previous_enabled: raw.previous_enabled === true,
	}
}

export const AUTO_PAUSED_RESUME_LABEL = 'Resume trigger (auto-paused by Slack)'
export const DEFAULT_RESUME_LABEL = 'Resume trigger'

/**
 * Dropdown copy for the Play/Pause item — the label branches on
 * `metadata.auto_paused.reason` so a user-paused trigger says "Resume
 * trigger" and an auto-paused one says "Resume trigger (auto-paused by
 * Slack)", making the two states legible from the same menu row.
 */
export function resumeTriggerLabel(trigger: TriggerResponse | null | undefined): string {
	return readAutoPausedInfo(trigger) ? AUTO_PAUSED_RESUME_LABEL : DEFAULT_RESUME_LABEL
}

interface ResumeOptions {
	/** Deterministic clock for tests. Defaults to `Date.now()`. */
	now?: () => number
}

/**
 * Shared resume behaviour for auto-paused Slack triggers — called from the
 * Pause/Play dropdown in `$triggerId.tsx` and from the red-banner Resume
 * button in `SlackTriggerSetupStatus`. Both surfaces must clear
 * `metadata.auto_paused` and fire the PostHog event, so the logic lives here
 * once instead of drifting between two call sites.
 *
 * The mutation asks the backend to strip `metadata.auto_paused` (via the
 * `clear_auto_paused` flag on `updateTriggerSchema`) — the banner + label
 * both key off that field, so its removal is what makes them disappear on
 * the next render after query invalidation.
 */
export function useSlackAutoResume(workspaceId: string, options: ResumeOptions = {}) {
	const updateTrigger = useUpdateTrigger(workspaceId)
	const nowFn = options.now ?? (() => Date.now())

	async function resume(trigger: TriggerResponse): Promise<void> {
		const autoPaused = readAutoPausedInfo(trigger)
		if (!autoPaused) {
			// Guard: the two surfaces that call this only render when auto-paused,
			// so this branch is a defensive no-op. A stale click after a
			// background query invalidation cleared the metadata shouldn't re-fire
			// resume through this path — the plain dropdown toggle owns the
			// user-paused case.
			return
		}
		const pausedAtMs = new Date(autoPaused.paused_at).getTime()
		const nowMs = nowFn()
		// Clamp to 0 in case of clock skew or a bad `paused_at` string; the
		// event is a soft telemetry signal, not something to error on.
		const timeSincePauseMs = Number.isFinite(pausedAtMs) ? Math.max(0, nowMs - pausedAtMs) : 0
		trackSlackTriggerResumedFromAutoPause({
			workspace_id: workspaceId,
			trigger_id: trigger.id,
			channel_id: autoPaused.channel_id,
			time_since_pause_ms: timeSincePauseMs,
		})
		await updateTrigger.mutateAsync({
			id: trigger.id,
			data: { enabled: true, clear_auto_paused: true },
		})
	}

	return { resume, isPending: updateTrigger.isPending }
}
