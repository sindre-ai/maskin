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

/**
 * Composite "no credits" pill overlay — rendered next to a `paused` loop's
 * state label when the workspace credit balance is empty. Not a member of the
 * `LoopSummary.pill` enum on purpose: the loop's stored status stays `paused`
 * and the wallet-empty signal comes from workspace billing (`credit_balance_cents`
 * on `BillingUsageResponse`), so the overlay is derived at render time rather
 * than pushed onto the read schema. Amber tokens match the `waiting_on_you`
 * pill family (see `LOOP_PILL_STYLES` above) so paused-by-credits and
 * needs-your-attention share one warning vocabulary.
 */
export const NO_CREDITS_PILL = {
	/** Verbatim per SPEC — desktop copy. */
	label: 'NO CREDITS',
	/** Verbatim per SPEC — mobile copy at ≤ 640px. */
	mobileLabel: 'NO CR.',
	/** Read out on both viewports so the abbreviation never reaches assistive tech. */
	ariaLabel: 'Paused — no credits',
	/** Tooltip copy verbatim per SPEC — surfaces the "why" and the fix in one line. */
	tooltip: 'Paused — the credit balance is empty. Top up in Billing.',
} as const

/**
 * Predicate for whether the NO CREDITS pill should render alongside a row's
 * state label. Kept as a pure function so LoopRow and any future consumer
 * (Objects list already ships its own PAUSED · NO CREDITS pill; a loop detail
 * header would reuse the same rule) can't drift on the "paused AND empty
 * wallet" definition.
 */
export function shouldShowNoCreditsPill(
	pill: LoopSummary['pill'],
	creditBalanceCents: number | null | undefined,
): boolean {
	return pill === 'paused' && typeof creditBalanceCents === 'number' && creditBalanceCents <= 0
}
