import { TargetCard } from '@/components/loops/target-card'
import {
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import {
	SortableContext,
	arrayMove,
	rectSortingStrategy,
	sortableKeyboardCoordinates,
	useSortable,
} from '@dnd-kit/sortable'
import type { ActorListItem, LoopSummary } from '@maskin/shared'
import { GripVertical } from 'lucide-react'

type LoopTarget = NonNullable<LoopSummary['targets']>[number]

/**
 * A target's id while it is dragged. Labels are not unique, so a repeat gets a
 * suffix; the id only has to be stable for the order on screen.
 */
export function targetIds(targets: readonly LoopTarget[]): string[] {
	const seen = new Map<string, number>()
	return targets.map((t) => {
		const n = (seen.get(t.label) ?? 0) + 1
		seen.set(t.label, n)
		return n === 1 ? t.label : `${t.label}#${n}`
	})
}

function SortableTarget({
	id,
	target,
	owner,
}: {
	id: string
	target: LoopTarget
	owner: ActorListItem | undefined
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	})
	return (
		<div
			ref={setNodeRef}
			className={isDragging ? 'relative z-10 opacity-80' : undefined}
			style={{
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
					: undefined,
				transition,
			}}
		>
			<TargetCard
				target={target}
				owner={owner}
				handle={
					<button
						type="button"
						aria-label={`Move ${target.label}`}
						className="-ml-1 grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
						{...attributes}
						{...listeners}
					>
						<GripVertical size={14} aria-hidden="true" />
					</button>
				}
			/>
		</div>
	)
}

/**
 * Loop-detail "TARGETS & OWNERS" section (bet D5). Renders one `<TargetCard>`
 * per target on the loop, on a responsive grid that stacks full-width on
 * mobile (≤ 640px) per the SPEC. Rendered only when the loop actually has
 * targets — a loop with `targets: null` (existing loops) reads nothing here.
 *
 * With `onReorder`, each card gets a drag handle (also operable from the keyboard:
 * Space to lift, arrows to move, Space to drop) and the new order is handed back.
 */
export function TargetsAndOwners({
	loop,
	actors,
	onReorder,
}: {
	loop: LoopSummary
	actors: ActorListItem[] | undefined
	/** The targets in their new order. Omitted for viewers, so no handle is offered. */
	onReorder?: (next: LoopTarget[]) => void
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	if (!loop.targets || loop.targets.length === 0) return null

	const targets = loop.targets
	const actorById = new Map<string, ActorListItem>((actors ?? []).map((a) => [a.id, a] as const))
	const ids = targetIds(targets)
	const ownerOf = (t: LoopTarget) => (t.ownerActorId ? actorById.get(t.ownerActorId) : undefined)

	function handleDragEnd({ active, over }: DragEndEvent) {
		if (!over || active.id === over.id || !onReorder) return
		const from = ids.indexOf(String(active.id))
		const to = ids.indexOf(String(over.id))
		if (from < 0 || to < 0) return
		onReorder(arrayMove(targets, from, to))
	}

	const grid = 'mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3'

	return (
		<section aria-label="Targets and owners">
			<h2 className="px-1 text-[13px] font-semibold text-muted-foreground">Targets</h2>
			{onReorder ? (
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext items={ids} strategy={rectSortingStrategy}>
						<div className={grid}>
							{targets.map((target, i) => (
								<SortableTarget
									key={ids[i]}
									id={ids[i] as string}
									target={target}
									owner={ownerOf(target)}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
			) : (
				<div className={grid}>
					{targets.map((target, i) => (
						<TargetCard key={ids[i]} target={target} owner={ownerOf(target)} />
					))}
				</div>
			)}
		</section>
	)
}
