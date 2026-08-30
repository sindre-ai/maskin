import { useSlackConversations } from '@/hooks/use-integrations'
import type { TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { SlackSetupJoinAttempt, SlackSetupMetadata } from '@maskin/shared'
import { AlertTriangle } from 'lucide-react'
import { useMemo } from 'react'
import { slackSetupCopyForStatus } from './slack-setup-copy'

// Statuses this banner treats as success (no row rendered). Anything else in
// `join_attempts` is a failure that shows up in the yellow banner.
const SUCCESS_STATUSES = new Set(['joined', 'already_in'])

interface SlackTriggerSetupStatusProps {
	trigger: TriggerResponse | undefined
	integrationId: string | undefined
	workspaceId: string
}

/**
 * Renders setup-outcome copy above the picker in `trigger-form.tsx` — reads
 * `trigger.metadata.slack_setup` written by `runSlackTriggerSetup` after the
 * trigger is saved.
 *
 * Two states live in this PR (spec §6):
 *   - **setup-failure**: yellow banner listing every channel whose join
 *     status is anything but 'joined' / 'already_in'. Copy is mapped per
 *     channel via `slackSetupCopyForStatus`.
 *   - **all-good**: no banner rendered (per-chip indicators in the picker do
 *     the talking — that's PR A).
 *
 * A third state — the red **auto-paused** banner — lands in PR C (Task 3)
 * when the `member_left_channel` handler ships. There is a comment slot for
 * it below so PR C is a one-place edit.
 */
export function SlackTriggerSetupStatus({
	trigger,
	integrationId,
	workspaceId,
}: SlackTriggerSetupStatusProps) {
	const slackSetup = readSlackSetup(trigger)
	// Resolve channel IDs to names via the same 5-min cache the picker uses,
	// so we don't hit Slack again just to render a banner.
	const { data: conversations } = useSlackConversations(integrationId, workspaceId)
	const nameById = useMemo(() => {
		const map = new Map<string, string>()
		for (const c of conversations ?? []) map.set(c.id, c.name)
		return map
	}, [conversations])

	if (!slackSetup) return null

	// PR C slot: auto_paused banner (state (1) in spec §6). Rendered from
	// `trigger.metadata.auto_paused` when the `member_left_channel` handler
	// lands — insert above the failure banner and short-circuit render.

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
