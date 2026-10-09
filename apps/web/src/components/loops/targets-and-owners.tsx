import { TargetCard } from '@/components/loops/target-card'
import type { ActorListItem, LoopSummary } from '@maskin/shared'

/**
 * Loop-detail "TARGETS & OWNERS" section (bet D5). Renders one `<TargetCard>`
 * per target on the loop, on a responsive grid that stacks full-width on
 * mobile (≤ 640px) per the SPEC. Rendered only when the loop actually has
 * targets — a loop with `targets: null` (existing loops) reads nothing here,
 * and the caller further gates on the `loops-v4-polish.targets` sub-flag so
 * the section can be reverted independently of the rest of the bet.
 */
export function TargetsAndOwners({
	loop,
	actors,
}: {
	loop: LoopSummary
	actors: ActorListItem[] | undefined
}) {
	if (!loop.targets || loop.targets.length === 0) return null

	const actorById = new Map<string, ActorListItem>((actors ?? []).map((a) => [a.id, a] as const))

	return (
		<section aria-label="Targets and owners" className="mt-9">
			<div className="flex items-center gap-2.5">
				<span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
					Targets &amp; owners
				</span>
				<div className="h-px flex-1 bg-muted" />
			</div>
			<div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
				{loop.targets.map((target, idx) => (
					<TargetCard
						key={`${target.label}-${idx}`}
						target={target}
						owner={target.ownerActorId ? actorById.get(target.ownerActorId) : undefined}
					/>
				))}
			</div>
		</section>
	)
}
