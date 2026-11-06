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

export type LoopTarget = NonNullable<LoopSummary['targets']>[number]

export interface PaceVerdict {
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
 * good-to-bad — `--st-opportunity-*` (used for "Behind pace") and
 * `--st-validated-*` (used for "Above target") are the *same* violet in both
 * light and dark mode, so the one thing the pill exists to say at a glance —
 * am I ahead or behind — did not come through at all. Green / amber / red is
 * the ordering the reader already expects, and both modes define all three.
 */
export function paceVerdict(target: LoopTarget): PaceVerdict {
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
	const percent =
		target.target > 0 ? Math.min(100, Math.max(0, (target.actual / target.target) * 100)) : 0

	return (
		<div
			data-testid="target-card"
			className={cn(
				'flex flex-col gap-2.5 rounded-xl border border-border bg-background px-[18px] py-3.5 shadow-xs',
				'transition-colors duration-150 hover:border-border-strong',
			)}
		>
			<div className="flex items-start justify-between gap-3">
				<span className="line-clamp-2 text-[14px] font-semibold leading-tight text-foreground">
					{target.label}
				</span>
				<span className="flex shrink-0 items-center gap-2">
					{owner && <ActorAvatar id={owner.id} name={owner.name} type={owner.type} size="sm" />}
					<span
						aria-label={verdict.description}
						className={cn(
							'inline-flex h-[22px] w-fit items-center rounded-full px-2.5',
							'text-[11.5px] font-bold',
							verdict.pillClass,
						)}
					>
						{verdict.label}
					</span>
				</span>
			</div>
			<p className="text-[26px] font-bold leading-[1.05] tracking-tight tabular-nums text-foreground">
				{target.actual} of {target.target}
			</p>
			<div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-border">
				<div
					className={cn(
						'h-full rounded-full',
						verdict.label === 'Missed'
							? 'bg-destructive'
							: verdict.label === 'Behind pace'
								? 'bg-brand'
								: 'bg-success',
					)}
					// Data-driven width: the one value a Tailwind class cannot carry.
					style={{ width: `${percent}%` }}
				/>
			</div>
		</div>
	)
}
