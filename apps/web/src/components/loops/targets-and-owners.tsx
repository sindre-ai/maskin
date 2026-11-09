import { TargetCard } from '@/components/loops/target-card'
import type { ActorListItem, LoopSummary } from '@maskin/shared'

/**
 * Loop-detail "TARGETS & OWNERS" section (bet D5). Renders one `<TargetCard>`
 * per target on the loop, on a responsive grid that stacks full-width on
 * mobile (≤ 640px) per the SPEC. Rendered only when the loop actually has
 * targets — a loop with `targets: null` (existing loops) reads nothing here.
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
		<section aria-label="Targets and owners">
			<h2 className="px-1 text-[13px] font-semibold text-muted-foreground">Targets</h2>
			<div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3">
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
