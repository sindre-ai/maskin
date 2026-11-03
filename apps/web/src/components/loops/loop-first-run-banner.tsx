import { describeTrigger } from '@/components/triggers/trigger-row'
import type { TriggerResponse } from '@/lib/api'

/**
 * Pre-first-run banner (mockup 1882–1887): "Built from what you said — nothing
 * has fired yet." Renders only for a loop that has produced no children and no
 * activity, and derives "the first cycle opens when …" from its own triggers.
 *
 * `EmptyState` is a centred whole-region empty; this is an inline informational
 * band with a leading ✦ tile that sits between the stats strip and the flow, so
 * it is genuinely a different pattern rather than a prop away from an existing
 * one.
 */
export function LoopFirstRunBanner({ triggers }: { triggers: TriggerResponse[] }) {
	return (
		<div className="flex items-start gap-3 rounded-xl border border-brand-subtle-foreground/30 bg-brand-subtle px-3.5 py-3">
			<span
				aria-hidden="true"
				className="grid size-6 shrink-0 place-items-center rounded-lg bg-primary text-[11px] text-primary-foreground"
			>
				✦
			</span>
			<p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-brand-subtle-foreground">
				Built from what you said — nothing has fired yet. The first cycle opens{' '}
				{describeFirstFire(triggers)}.
			</p>
		</div>
	)
}

/** Plain-English "when the first cycle opens", read off the loop's own triggers
 *  through the same `describeTrigger()` the trigger rows use. */
export function describeFirstFire(triggers: TriggerResponse[]): string {
	const enabled = triggers.filter((t) => t.enabled)
	const first = enabled[0] ?? triggers[0]
	if (!first) return 'as soon as a trigger is attached to it'
	return lowerFirst(describeTrigger(first))
}

function lowerFirst(s: string): string {
	return s.length === 0 ? s : (s[0] as string).toLowerCase() + s.slice(1)
}
