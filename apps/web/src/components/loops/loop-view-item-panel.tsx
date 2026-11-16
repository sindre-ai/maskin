import { LinkedObjectCard } from '@/components/chat/linked-object-preview'
import { LinkedPanelContext } from '@/components/chat/linked-panel-context'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { Button } from '@/components/ui/button'
import { useObject } from '@/hooks/use-objects'
import { trackLoopViewCardAction } from '@/lib/analytics'
import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

interface LoopViewItemPanelProps {
	workspaceId: string
	loopId: string
	objectId: string
	onClose: () => void
}

/**
 * The card a person knows from chat, shown beside a loop view for the item the view asked to
 * open. It acts as the person with no chat attached, so no agent is woken. The view itself
 * never changes anything: every change is made here, on the card.
 */
export function LoopViewItemPanel({
	workspaceId,
	loopId,
	objectId,
	onClose,
}: LoopViewItemPanelProps) {
	const { data: object, isLoading } = useObject(objectId)
	const found = object && object.workspaceId === workspaceId ? object : null

	// One event per open: a different item is a new open, a refetch of the same one is not.
	const foundId = found?.id
	const foundType = found?.type
	const trackedRef = useRef<string | null>(null)
	// biome-ignore lint/correctness/useExhaustiveDependencies: only a newly found item is a new open
	useEffect(() => {
		if (!foundId || !foundType || trackedRef.current === foundId) return
		trackedRef.current = foundId
		trackLoopViewCardAction({
			entity_id: foundId,
			object_type: foundType,
			loop_id: loopId,
			action: 'open',
		})
	}, [foundId, foundType])

	return (
		<section aria-label="Item" className="flex min-w-0 flex-col gap-2">
			<div className="flex justify-end">
				<Button type="button" variant="ghost" size="sm" onClick={onClose}>
					<X className="size-3.5" aria-hidden="true" />
					Close
				</Button>
			</div>
			{isLoading ? (
				<Skeleton className="h-24 w-full rounded-md" />
			) : found ? (
				// The card is already in the panel, so it must not offer "Show in panel".
				<LinkedPanelContext.Provider value={null}>
					<LinkedObjectCard
						key={found.id}
						workspaceId={workspaceId}
						objectId={found.id}
						standalone
						defaultExpanded
						className="mt-0 max-w-none"
						onAction={(action) =>
							trackLoopViewCardAction({
								entity_id: found.id,
								object_type: found.type,
								loop_id: loopId,
								action,
							})
						}
					/>
				</LinkedPanelContext.Provider>
			) : (
				<EmptyState title="Can't open this item" description="It may have been deleted." />
			)}
		</section>
	)
}
