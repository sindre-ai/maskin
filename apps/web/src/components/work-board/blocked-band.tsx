import { Card } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ObjectResponse } from '@/lib/api'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

interface BlockedBandProps {
	tasks: ObjectResponse[]
}

/**
 * Collapsible "Blocked" band rendered beneath each swimlane. Defaults to
 * collapsed when the band is empty (because there's nothing actionable) and
 * expanded when there's at least one blocked task — blocked items must be
 * visible, just not in the main column flow.
 */
export function BlockedBand({ tasks }: BlockedBandProps) {
	const hasBlocked = tasks.length > 0
	const [open, setOpen] = useState(hasBlocked)

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="mt-2">
			<CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-md border border-dashed bg-status-blocked-bg/30 px-3 py-1.5 text-xs text-status-blocked-text hover:bg-status-blocked-bg/50 transition-colors">
				<ChevronRight
					size={14}
					className="transition-transform group-data-[state=open]:rotate-90"
				/>
				<span className="font-medium uppercase tracking-wide">Blocked</span>
				<span className="font-mono tabular-nums">{tasks.length}</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-2 flex flex-col gap-2 px-3">
					{hasBlocked ? (
						tasks.map((task) => (
							<Card key={task.id} className="p-3 shadow-sm" data-task-id={task.id}>
								<p className="text-sm font-medium leading-snug line-clamp-2">
									{task.title || 'Untitled task'}
								</p>
							</Card>
						))
					) : (
						<p className="text-xs text-muted-foreground/70 py-1">
							No blocked tasks. Blocked items appear here so they don&apos;t hide in a column.
						</p>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	)
}
