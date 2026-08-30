import { useSlackConversations } from '@/hooks/use-integrations'
import { useSlackAutoResume } from '@/hooks/use-slack-auto-resume'
import type { TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { SlackSetupJoinAttempt, SlackSetupMetadata } from '@maskin/shared'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { slackMemberLeftCopy, slackSetupCopyForStatus } from './slack-setup-copy'

// Statuses this banner treats as success (no row rendered). Anything else in
// `join_attempts` is a failure that shows up in the yellow banner.
const SUCCESS_STATUSES = new Set(['joined', 'already_in'])

/**
 * Shape stamped on `trigger.metadata.auto_paused` by the
 * `handleMemberLeftChannel` webhook handler when Maskin's bot is kicked from
 * a channel a trigger listens on. Kept in sync with `AutoPausedMetadata` in
 * apps/dev's `providers/slack/webhooks.ts` — the frontend defensively narrows
 * the shape rather than importing from a server-only path, so a schema drift
 * degrades to "no red banner" instead of a hard render error.
 */
interface AutoPausedMetadata {
	reason: 'slack_member_left'
	channel_id: string
	paused_at: string
	previous_enabled: boolean
}

interface SlackTriggerSetupStatusProps {
	trigger: TriggerResponse | undefined
	integrationId: string | undefined
	workspaceId: string
}

/**
 * Renders setup-outcome copy above the picker in `trigger-form.tsx` — reads
 * `trigger.metadata.slack_setup` (from `runSlackTriggerSetup`) and
 * `trigger.metadata.auto_paused` (from `handleMemberLeftChannel`).
 *
 * Three states live here now:
 *   - **auto-paused (PR C)**: red banner + Resume button + one-time toast on
 *     first visit after the pause. Highest priority — short-circuits render
 *     before the setup-failure check because the trigger is genuinely stopped.
 *   - **setup-failure (PR B)**: yellow banner listing every channel whose
 *     join status is anything but 'joined' / 'already_in'.
 *   - **all-good**: no banner rendered (per-chip indicators in the picker
 *     do the talking — that's PR A).
 */
export function SlackTriggerSetupStatus({
	trigger,
	integrationId,
	workspaceId,
}: SlackTriggerSetupStatusProps) {
	const autoPaused = readAutoPaused(trigger)
	const slackSetup = readSlackSetup(trigger)
	// PR D — the Resume button now performs the real resume (clears
	// `metadata.auto_paused` + PATCHes enabled=true + fires the resume PostHog
	// event) instead of the PR C placeholder toast. Same hook is called from
	// the Pause/Play dropdown in $triggerId.tsx so the two Resume affordances
	// stay in lockstep.
	const autoResume = useSlackAutoResume(workspaceId)
	// Resolve channel IDs to names via the same 5-min cache the picker uses,
	// so we don't hit Slack again just to render a banner.
	const { data: conversations } = useSlackConversations(integrationId, workspaceId)
	const nameById = useMemo(() => {
		const map = new Map<string, string>()
		for (const c of conversations ?? []) map.set(c.id, c.name)
		return map
	}, [conversations])

	const autoPausedChannelName = autoPaused
		? (nameById.get(autoPaused.channel_id) ?? autoPaused.channel_id)
		: null

	// One-time toast on the trigger owner's next visit after an auto-pause
	// event. Keyed on (trigger id, paused_at) so a fresh auto-pause re-notifies
	// without spamming on every re-render / route re-mount inside the same
	// visit. Guarded on typeof window because vitest's DOM env can call this
	// before jsdom sets up localStorage in some setups.
	useEffect(() => {
		if (!autoPaused || !trigger || !autoPausedChannelName) return
		if (typeof window === 'undefined' || !window.localStorage) return
		const seenKey = `slack-auto-pause-toast:${trigger.id}:${autoPaused.paused_at}`
		if (window.localStorage.getItem(seenKey)) return
		try {
			window.localStorage.setItem(seenKey, '1')
		} catch {
			// Storage quota / disabled localStorage — no persistent dedup, but
			// still fire the toast; a duplicate is preferable to a missed one.
		}
		toast.warning(slackMemberLeftCopy(autoPausedChannelName), {
			description: `Trigger "${trigger.name}" is paused until you reinvite Maskin.`,
		})
	}, [autoPaused, trigger, autoPausedChannelName])

	if (autoPaused && trigger && autoPausedChannelName) {
		return (
			<div
				role="alert"
				className={cn(
					'mb-3 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5',
				)}
				data-testid="slack-trigger-setup-status"
				data-state="auto-paused"
			>
				<AlertTriangle
					size={14}
					className="mt-0.5 shrink-0 text-destructive"
					aria-hidden="true"
				/>
				<div className="flex-1 space-y-2 text-[12px] leading-snug text-foreground">
					<p>{slackMemberLeftCopy(autoPausedChannelName)}</p>
					<button
						type="button"
						onClick={() => {
							// Fire-and-forget — the hook internally uses `mutateAsync`
							// and swallows nothing, but the banner shouldn't crash on
							// a rejected promise (the mutation surfaces its own error
							// state via query cache invalidation).
							autoResume.resume(trigger).catch(() => {})
						}}
						disabled={autoResume.isPending}
						className={cn(
							'rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1 text-[11.5px] font-semibold text-destructive',
							'transition-colors hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50',
							'disabled:opacity-60 disabled:cursor-not-allowed',
						)}
						data-testid="slack-auto-pause-resume"
					>
						Resume trigger
					</button>
				</div>
			</div>
		)
	}

	if (!slackSetup) return null

	const failures = slackSetup.join_attempts.filter((a) => !SUCCESS_STATUSES.has(a.status))
	if (failures.length === 0) return null

	return (
		<div
			role="alert"
			className={cn(
				'mb-3 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5',
			)}
			data-testid="slack-trigger-setup-status"
			data-state="setup-failure"
		>
			<AlertTriangle
				size={14}
				className="mt-0.5 shrink-0 text-warning"
				aria-hidden="true"
			/>
			<ul className="space-y-1 text-[12px] leading-snug text-foreground">
				{failures.map((attempt) => (
					<li key={`${attempt.channel_id}:${attempt.attempted_at}`}>
						{slackSetupCopyForStatus(attempt.status, {
							channelName: nameById.get(attempt.channel_id) ?? attempt.channel_id,
							slackError: attempt.error,
						})}
					</li>
				))}
			</ul>
		</div>
	)
}

/**
 * Best-effort read of `trigger.metadata.auto_paused`. Only recognises the
 * `slack_member_left` reason for now — a future reason would fall through and
 * render as absent rather than mis-render into the wrong banner shape.
 */
function readAutoPaused(trigger: TriggerResponse | undefined): AutoPausedMetadata | null {
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

/**
 * Best-effort read of `trigger.metadata.slack_setup`. Metadata is typed as an
 * open record on the response schema (no zod parse per render), so we defensively
 * shape-check the fields the banner reads. A malformed value renders as absent
 * rather than crashing the form.
 */
function readSlackSetup(trigger: TriggerResponse | undefined): SlackSetupMetadata | null {
	if (!trigger) return null
	const md = trigger.metadata as Record<string, unknown> | null | undefined
	const raw = md?.slack_setup as Record<string, unknown> | undefined
	if (!raw) return null
	if (!Array.isArray(raw.channel_ids)) return null
	if (!Array.isArray(raw.join_attempts)) return null
	const attempts: SlackSetupJoinAttempt[] = []
	for (const a of raw.join_attempts as Array<Record<string, unknown>>) {
		if (typeof a?.channel_id !== 'string' || typeof a?.status !== 'string') continue
		attempts.push({
			channel_id: a.channel_id,
			status: a.status as SlackSetupJoinAttempt['status'],
			error: typeof a.error === 'string' ? a.error : undefined,
			attempted_at:
				typeof a.attempted_at === 'string' ? a.attempted_at : new Date(0).toISOString(),
		})
	}
	return {
		channel_ids: raw.channel_ids as string[],
		join_attempts: attempts,
		confirmation_posted_at:
			(raw.confirmation_posted_at as Record<string, string> | undefined) ?? undefined,
		last_setup_at:
			typeof raw.last_setup_at === 'string' ? raw.last_setup_at : new Date(0).toISOString(),
	}
}
