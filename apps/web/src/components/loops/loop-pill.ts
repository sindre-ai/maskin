import type { LoopSummary } from '@/lib/api'

/** The graduated-autonomy stages a loop actually runs in — `draft` is not yet
 *  live and `paused` has stopped, so neither belongs here. Drives the pulsing
 *  dot and the "is this loop working right now" reads across Loops. */
export const LOOP_LIVE_STATUSES = new Set<LoopSummary['pill']>([
	'learning',
	'supervised',
	'fully_autonomous',
])

export function isLoopLive(pill: LoopSummary['pill']): boolean {
	return LOOP_LIVE_STATUSES.has(pill)
}

/** One entry per `loopPillSchema` value — the ladder (`packages/shared/src/
 *  schemas/objects.ts` `LOOP_STATUSES`) plus the per-viewer `waiting_on_you`
 *  override. The stage is the label: a loop reads as the trust level it has
 *  earned, not as a generic "Running". */
export const LOOP_PILL_STYLES: Record<
	LoopSummary['pill'],
	{ label: string; dot: string; text: string }
> = {
	draft: { label: 'Draft', dot: 'bg-border-strong', text: 'text-muted-foreground' },
	learning: { label: 'Learning', dot: 'bg-success', text: 'text-success' },
	supervised: { label: 'Supervised', dot: 'bg-success', text: 'text-success' },
	fully_autonomous: { label: 'Fully autonomous', dot: 'bg-success', text: 'text-success' },
	waiting_on_you: { label: 'Waiting on you', dot: 'bg-warning', text: 'text-warning' },
	paused: { label: 'Paused', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
}
