import { ActorAvatar } from '@/components/shared/actor-avatar'
import { cn } from '@/lib/cn'
import type { ActorListItem, LoopSummary } from '@maskin/shared'

/**
 * A single row inside the loop-detail `<TargetsAndOwners>` section
 * (bet D5). Renders one loop target: label, actual, target, pace pill, owner
 * avatar. Pace is derived here on render from `actual` / `target` (+ optional
 * `pace_policy`); nothing about it is persisted. Persisting pace would desync
 * on the next write.
 *
 * Copy is verbatim from the SPEC ("Above target" / "On target" / "Behind pace"
 * / "Missed") — if the label reads differently on the surface, the tokens on
 * this component don't match the design bet's ship gate.
 */

type LoopTarget = NonNullable<LoopSummary['targets']>[number]

interface PaceVerdict {
	label: 'Above target' | 'On target' | 'Behind pace' | 'Missed'
	/** Tailwind classes for the pill background + text. Kept in sync with the
	 *  amber / green / grey palette v4 uses on `loop-pill.ts`. */
	pillClass: string
	/** aria-label extension: `"Behind pace — 6 of 8"` — SPEC a11y detail. */
	description: string
}

/**
 * Pace pills carry their own success/warning/destructive tokens rather than
 * borrowing the status palette. The status tokens are not ordered by
 * good-to-bad — `--st-signal-*` (used for "Behind pace") and
 * `--st-validated-*` (used for "Above target") are the *same* violet in both
 * light and dark mode, so the one thing the pill exists to say at a glance —
 * am I ahead or behind — did not come through at all. Green / amber / red is
 * the ordering the reader already expects, and both modes define all three.
 */
function paceVerdict(target: LoopTarget): PaceVerdict {
	const { actual, target: goal, pace_policy } = target
	const isMissed = goal > 0 && actual <= 0
	const ratio = goal !== 0 ? actual / goal : actual > 0 ? 1 : 0
	const numbers = `${actual} of ${goal}`

	if (isMissed) {
		return {
			label: 'Missed',
			pillClass: 'bg-destructive/10 text-destructive',
			description: `Missed — ${numbers}`,
		}
	}
	if (ratio >= 1) {
		return {
			label: 'Above target',
			pillClass: 'bg-success/15 text-success',
			description: `Above target — ${numbers}`,
		}
	}
	// `strict` — anything under target reads "Behind pace". `window` — allow
	// a small tolerance (≥ 0.9) as "On target". Default (no policy) mirrors
	// `window`; the bet SPEC leaves the default policy soft on purpose so an
	// early-cycle number doesn't flash red before it's had time to move.
	const onTargetFloor = pace_policy === 'strict' ? 1 : 0.9
	if (ratio >= onTargetFloor) {
		return {
			label: 'On target',
			pillClass: 'bg-success/10 text-success',
			description: `On target — ${numbers}`,
		}
	}
	return {
		label: 'Behind pace',
		pillClass: 'bg-warning/10 text-warning',
		description: `Behind pace — ${numbers}`,
	}
}

export interface TargetCardProps {
	target: LoopTarget
	/** Owner lookup — pass the workspace's `useActors()` result so the avatar
	 *  renders with the actor's real name and identity color; missing owners
	 *  render nothing (the card still shows the pace pill + numbers). */
	owner?: ActorListItem | null
}

export function TargetCard({ target, owner }: TargetCardProps) {
	const verdict = paceVerdict(target)

	return (
		<div
			data-testid="target-card"
			className={cn(
				'flex flex-col gap-2 rounded-lg border border-border bg-card p-4',
				'transition-colors duration-150 hover:border-border-strong',
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<span className="text-[12px] font-medium leading-tight text-foreground line-clamp-2">
					{target.label}
				</span>
				{owner && <ActorAvatar id={owner.id} name={owner.name} type={owner.type} size="sm" />}
			</div>
			<div className="flex items-baseline gap-1.5">
				<span className="font-mono text-[20px] font-semibold tabular-nums text-foreground">
					{target.actual}
				</span>
				<span className="text-[12px] text-muted-foreground">/ {target.target}</span>
			</div>
			<span
				aria-label={verdict.description}
				className={cn(
					'inline-flex w-fit items-center rounded-full px-2 py-0.5',
					'font-mono text-[10px] font-semibold uppercase tracking-[0.06em]',
					verdict.pillClass,
				)}
			>
				{verdict.label}
			</span>
		</div>
	)
}
