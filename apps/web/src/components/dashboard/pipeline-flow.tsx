import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { useBets } from '@/hooks/use-bets'
import { useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import type { ObjectResponse } from '@/lib/api'
import { computeNewOrderForInsert, sortBetsByOrder } from '@/lib/bet-order'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
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
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { GripVertical } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'

const PROPOSED_BET_STATUSES = new Set(['proposed'])
const ACTIVE_BET_STATUSES = new Set(['active'])
const DONE_BET_STATUSES = new Set(['completed', 'archived'])

const VISIBLE_PER_COLUMN = 5

const MISSIONS_SEARCH = {
	type: 'bet',
	status: undefined,
	owner: undefined,
	sort: 'createdAt',
	order: 'desc' as const,
	q: undefined,
	groupBy: undefined,
	ids: undefined,
}

type ColumnKey = 'proposed' | 'active' | 'done'

const COLUMNS: Array<{
	key: ColumnKey
	label: string
	statuses: Set<string>
	highlight?: boolean
}> = [
	{ key: 'proposed', label: 'Proposed', statuses: PROPOSED_BET_STATUSES },
	{ key: 'active', label: 'In Progress', statuses: ACTIVE_BET_STATUSES, highlight: true },
	{ key: 'done', label: 'Done', statuses: DONE_BET_STATUSES },
]

export function PipelineFlow() {
	const { workspaceId } = useWorkspace()
	const { data: bets, isLoading: betsLoading } = useBets(workspaceId)
	const { data: relationships, isLoading: relsLoading } = useRelationships(workspaceId)
	const updateObject = useUpdateObject(workspaceId)
	const queryClient = useQueryClient()

	const columns = useMemo(() => {
		const all: ObjectResponse[] = bets ?? []
		return COLUMNS.map((col) => ({
			...col,
			bets: sortBetsByOrder(all.filter((b) => col.statuses.has(b.status))),
		}))
	}, [bets])

	const taskCountByBet = useMemo(() => {
		const counts = new Map<string, number>()
		for (const r of relationships ?? []) {
			if (r.type !== 'breaks_into') continue
			counts.set(r.sourceId, (counts.get(r.sourceId) ?? 0) + 1)
		}
		return counts
	}, [relationships])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	function handleDragEnd(columnKey: ColumnKey, event: DragEndEvent) {
		const { active, over } = event
		if (!over || active.id === over.id) return

		const column = columns.find((c) => c.key === columnKey)
		if (!column) return

		const fromIndex = column.bets.findIndex((b) => b.id === active.id)
		const toIndex = column.bets.findIndex((b) => b.id === over.id)
		if (fromIndex === -1 || toIndex === -1) return

		const movedBet = column.bets[fromIndex]
		const without = column.bets.filter((_, i) => i !== fromIndex)
		const newOrder = computeNewOrderForInsert(without, toIndex)

		const previousMetadata = movedBet.metadata ?? {}
		const nextMetadata = { ...previousMetadata, order: newOrder }

		queryClient.setQueryData<ObjectResponse[]>(queryKeys.bets.all(workspaceId), (prev) =>
			prev ? prev.map((b) => (b.id === movedBet.id ? { ...b, metadata: nextMetadata } : b)) : prev,
		)

		updateObject.mutate(
			{ id: movedBet.id, data: { metadata: nextMetadata } },
			{
				onError: () => {
					toast.error('Could not save the new order — reverted.')
					queryClient.invalidateQueries({ queryKey: queryKeys.bets.all(workspaceId) })
				},
			},
		)
	}

	if (betsLoading || relsLoading) {
		return (
			<section className="space-y-4">
				<SectionHeader title="Pipeline" />
				<div className="grid gap-4 grid-cols-1 md:grid-cols-3">
					<CardSkeleton />
					<CardSkeleton />
					<CardSkeleton />
				</div>
			</section>
		)
	}

	const total = columns.reduce((sum, c) => sum + c.bets.length, 0)
	if (total === 0) {
		return (
			<EmptyState
				title="No bets in flight"
				description="Create a bet to see it move through Proposed → In Progress → Done."
			/>
		)
	}

	return (
		<section className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<SectionHeader title="Pipeline" />
				<Link
					to="/$workspaceId/objects"
					params={{ workspaceId }}
					search={MISSIONS_SEARCH}
					className="text-xs text-muted-foreground hover:text-foreground transition-colors"
				>
					See all in Missions →
				</Link>
			</div>
			<div className="grid gap-4 grid-cols-1 md:grid-cols-3">
				{columns.map((col) => (
					<PipelineColumn
						key={col.key}
						label={col.label}
						highlight={col.highlight}
						bets={col.bets}
						taskCountByBet={taskCountByBet}
						workspaceId={workspaceId}
						sensors={sensors}
						onDragEnd={(e) => handleDragEnd(col.key, e)}
					/>
				))}
			</div>
		</section>
	)
}

function PipelineColumn({
	label,
	highlight,
	bets,
	taskCountByBet,
	workspaceId,
	sensors,
	onDragEnd,
}: {
	label: string
	highlight?: boolean
	bets: ObjectResponse[]
	taskCountByBet: Map<string, number>
	workspaceId: string
	sensors: ReturnType<typeof useSensors>
	onDragEnd: (event: DragEndEvent) => void
}) {
	const visible = bets.slice(0, VISIBLE_PER_COLUMN)
	const overflow = bets.length - visible.length

	return (
		<div
			className={cn(
				'flex flex-col gap-3 rounded-lg border bg-card p-3',
				highlight ? 'border-accent/60' : 'border-border',
			)}
		>
			<div className="flex items-center justify-between px-1">
				<p
					className={cn(
						'text-xs font-medium uppercase tracking-wider',
						highlight ? 'text-accent' : 'text-muted-foreground',
					)}
				>
					{label}
				</p>
				<span className="text-xs text-muted-foreground">{bets.length}</span>
			</div>

			{visible.length === 0 ? (
				<p className="px-1 py-3 text-xs text-muted-foreground/70 italic">Empty</p>
			) : (
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
					<SortableContext items={visible.map((b) => b.id)} strategy={verticalListSortingStrategy}>
						<ul className="flex flex-col gap-2">
							{visible.map((bet) => (
								<SortableBetItem
									key={bet.id}
									bet={bet}
									taskCount={taskCountByBet.get(bet.id) ?? 0}
									workspaceId={workspaceId}
								/>
							))}
						</ul>
					</SortableContext>
				</DndContext>
			)}

			{overflow > 0 && (
				<Link
					to="/$workspaceId/objects"
					params={{ workspaceId }}
					search={MISSIONS_SEARCH}
					className="px-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
				>
					+{overflow} more →
				</Link>
			)}
		</div>
	)
}

function SortableBetItem({
	bet,
	taskCount,
	workspaceId,
}: {
	bet: ObjectResponse
	taskCount: number
	workspaceId: string
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: bet.id,
	})

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	}

	return (
		<li
			ref={setNodeRef}
			style={style}
			className={cn(
				'flex items-stretch rounded-lg border border-border bg-card shadow-md transition-colors',
				isDragging && 'opacity-60 ring-2 ring-accent/40',
			)}
		>
			<button
				type="button"
				aria-label={`Reorder ${bet.title || 'bet'}`}
				className="flex min-h-[44px] min-w-[44px] cursor-grab touch-none items-center justify-center rounded-l-lg text-muted-foreground hover:text-foreground active:cursor-grabbing"
				{...attributes}
				{...listeners}
			>
				<GripVertical size={16} />
			</button>
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: bet.id }}
				className="flex-1 rounded-r-lg p-3 hover:bg-accent/30 transition-colors"
			>
				<div className="flex items-start justify-between gap-2">
					<h3 className="text-sm font-medium text-foreground leading-tight">
						{bet.title || 'Untitled bet'}
					</h3>
					<StatusBadge status={bet.status} />
				</div>
				<div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
					<span>
						{taskCount} task{taskCount !== 1 ? 's' : ''}
					</span>
					{bet.updatedAt && (
						<>
							<span className="text-border">·</span>
							<RelativeTime date={bet.updatedAt} />
						</>
					)}
				</div>
			</Link>
		</li>
	)
}

function SectionHeader({ title }: { title: string }) {
	return (
		<h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
	)
}
