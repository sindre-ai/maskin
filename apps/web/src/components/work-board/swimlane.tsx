import { StatusBadge } from '@/components/shared/status-badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Column } from '@/components/work-board/column'
import type { BoardSwimlane } from '@/hooks/use-work-board'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

interface SwimlaneProps {
	lane: BoardSwimlane
}

/**
 * One bet's lane: header (bet title + status) and columns. Active bets render
 * expanded by default; inactive bets and the "No bet" lane render collapsed
 * so the room stays scannable.
 */
export function Swimlane({ lane }: SwimlaneProps) {
	const total = Object.values(lane.columns).reduce((sum, col) => sum + col.length, 0)

	// Active bets default open. Inactive bets and the "No bet" lane default closed
	// per the bet's spec. The "No bet" lane is `isActive: true` in the model, but
	// it's a signal-of-orphan-tasks lane and starts collapsed so it doesn't crowd
	// the active work.
	const isNoBetLane = lane.bet === null
	const [open, setOpen] = useState(lane.isActive && !isNoBetLane)

	const title = lane.bet?.title ?? 'No bet'
	const status = lane.bet?.status
	const laneId = lane.bet?.id ?? 'no-bet'

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className="border rounded-md bg-background"
			data-bet-id={lane.bet?.id ?? 'no-bet'}
		>
			<CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors rounded-t-md">
				<ChevronRight
					size={16}
					className="transition-transform group-data-[state=open]:rotate-90 text-muted-foreground"
				/>
				<span className="text-sm font-medium truncate">{title}</span>
				{status && <StatusBadge status={status} />}
				<span className="ml-auto text-xs text-muted-foreground font-mono tabular-nums">
					{total} {total === 1 ? 'task' : 'tasks'}
				</span>
			</CollapsibleTrigger>

			<CollapsibleContent>
				<div className="px-3 pb-3">
					{total === 0 ? (
						<p className="text-xs text-muted-foreground py-3 text-center">
							{isNoBetLane
								? 'Tasks not attached to a bet land here.'
								: 'No tasks under this bet yet. Add one to get started.'}
						</p>
					) : (
						<div className="flex gap-3 overflow-x-auto pb-2">
							{Object.entries(lane.columns).map(([status, tasks]) => (
								<Column key={status} status={status} tasks={tasks} laneId={laneId} />
							))}
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
