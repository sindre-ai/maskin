import type { LoopSummary } from '@/lib/api'

export const LOOP_PILL_STYLES: Record<
	LoopSummary['pill'],
	{ label: string; dot: string; text: string }
> = {
	draft: { label: 'Draft', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
	paused: { label: 'Paused', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
	learning: { label: 'Learning', dot: 'bg-primary', text: 'text-foreground' },
	supervised: { label: 'Supervised', dot: 'bg-primary', text: 'text-foreground' },
	fully_autonomous: { label: 'Fully autonomous', dot: 'bg-success', text: 'text-success' },
	waiting_on_you: { label: 'Waiting on you', dot: 'bg-warning', text: 'text-warning' },
}

/**
 * The three "live" rungs of the autonomy ladder — a loop that is actually
 * running work through its triggers. `draft` and `paused` are not live, and
 * `waiting_on_you` is a per-viewer overlay on a live status rather than a
 * state of the loop itself (see `loopPillSchema` in
 * `packages/shared/src/schemas/loops.ts`).
 *
 * This replaces the pre-#1396 single `running` status: the status model became
 * a graduated ladder, so "is this loop working?" is now a set membership test
 * rather than an equality check. Defined once here so the pulsing-dot and
 * colour rules in LoopRow / LoopStats / the loop detail header can't drift.
 */
const LIVE_LOOP_PILLS = new Set<LoopSummary['pill']>(['learning', 'supervised', 'fully_autonomous'])

export function isLiveLoopPill(pill: LoopSummary['pill']): boolean {
	return LIVE_LOOP_PILLS.has(pill)
}
