import type { EventResponse } from '@/lib/api'
import { useMemo } from 'react'
import { ActivityComment } from './activity-comment'
import { ActivityItem } from './activity-item'
import { CommentInput } from './comment-input'

interface ObjectActivityProps {
	workspaceId: string
	objectId: string
	events?: EventResponse[]
}

export function ObjectActivity({ workspaceId, objectId, events }: ObjectActivityProps) {
	// Group events: separate comments from system events, group replies under parents
	const { topLevel, repliesByParent } = useMemo(() => {
		if (!events) return { topLevel: [], repliesByParent: new Map<number, EventResponse[]>() }

		const replies = new Map<number, EventResponse[]>()
		const top: EventResponse[] = []

		// Events come from API sorted desc (newest first), reverse for chronological display
		const sorted = [...events].reverse()

		for (const event of sorted) {
			if (event.action === 'commented') {
				const parentId = event.data?.parentEventId as number | undefined
				if (parentId) {
					const existing = replies.get(parentId) ?? []
					existing.push(event)
					replies.set(parentId, existing)
				} else {
					top.push(event)
				}
			} else {
				top.push(event)
			}
		}

		return { topLevel: top, repliesByParent: replies }
	}, [events])

	return (
		<div className="border-t border-border pt-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
				Activity
			</h3>

			<CommentInput workspaceId={workspaceId} objectId={objectId} />

			<div className="mt-4 space-y-0.5">
				{topLevel.length === 0 && (
					<p className="text-sm text-muted-foreground py-4 text-center">No activity yet</p>
				)}
				{topLevel.map((event) =>
					event.action === 'commented' ? (
						<ActivityComment
							key={event.id}
							event={event}
							replies={repliesByParent.get(event.id) ?? []}
							workspaceId={workspaceId}
							objectId={objectId}
						/>
					) : (
						<ActivityItem key={event.id} event={event} compact />
					),
				)}
			</div>
		</div>
	)
}
