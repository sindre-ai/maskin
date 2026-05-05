import { EmptyState } from '@/components/shared/empty-state'
import { CardSkeleton } from '@/components/shared/loading-skeleton'
import { Swimlane } from '@/components/work-board/swimlane'
import { useWorkBoard } from '@/hooks/use-work-board'

/**
 * Top-level board: vertical stack of bet swimlanes. Each lane lays out columns
 * for the workspace's task statuses. Drag-and-drop, filters, and the rich card
 * surface come in later tasks.
 */
export function Board() {
	const { board, isLoading, error } = useWorkBoard()

	if (isLoading) {
		return (
			<div className="flex flex-col gap-3 p-4">
				<CardSkeleton />
				<CardSkeleton />
				<CardSkeleton />
			</div>
		)
	}

	if (error) {
		return (
			<EmptyState
				title="Could not load the board"
				description={error.message ?? 'Try refreshing the page.'}
			/>
		)
	}

	if (board.swimlanes.length === 0) {
		return (
			<EmptyState
				title="No bets or tasks yet"
				description="Create a bet and break it into tasks to see swimlanes here. Loose tasks land in a 'No bet' lane at the bottom."
			/>
		)
	}

	return (
		<div className="flex flex-col gap-3 p-4">
			{board.swimlanes.map((lane) => (
				<Swimlane key={lane.bet?.id ?? 'no-bet'} lane={lane} />
			))}
		</div>
	)
}
