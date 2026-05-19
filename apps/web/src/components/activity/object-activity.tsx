import { useActors } from '@/hooks/use-actors'
import type { ActorListItem, EventResponse, ObjectResponse } from '@/lib/api'
import { useMemo } from 'react'
import { StreamingIndicator } from '../shared/streaming-indicator'
import { ActivityComment } from './activity-comment'
import { ActivityItem } from './activity-item'
import { buildPhases } from './build-phases'
import { CommentInput } from './comment-input'
import { formatStatusTransitionShort } from './format-event'
import { PhaseDivider } from './phase-divider'

interface ObjectActivityProps {
	workspaceId: string
	object: ObjectResponse
	events?: EventResponse[]
	activeSessionId?: string | null
}

export function ObjectActivity({
	workspaceId,
	object,
	events,
	activeSessionId,
}: ObjectActivityProps) {
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	// Events arrive from the API sorted desc (newest first); reverse for chronological grouping.
	// Then bucket replies under their parent comment so threads stay intact within phases.
	const { phases, repliesByParent, totalTopLevel } = useMemo(() => {
		if (!events) {
			return {
				phases: [] as ReturnType<typeof buildPhases>,
				repliesByParent: new Map<number, EventResponse[]>(),
				totalTopLevel: 0,
			}
		}

		const chronological = [...events].reverse()

		const replies = new Map<number, EventResponse[]>()
		const topLevel: EventResponse[] = []
		for (const event of chronological) {
			if (event.action === 'commented') {
				const parentId = event.data?.parentEventId as number | undefined
				if (parentId) {
					const existing = replies.get(parentId) ?? []
					existing.push(event)
					replies.set(parentId, existing)
					continue
				}
			}
			topLevel.push(event)
		}

		const visiblePhases = buildPhases(topLevel, object).filter((p) => p.events.length > 0)

		return {
			phases: visiblePhases,
			repliesByParent: replies,
			totalTopLevel: topLevel.length,
		}
	}, [events, object])

	return (
		<div className="border-t border-border pt-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-3">
				Activity
			</h3>

			{activeSessionId && (
				<div className="mb-3">
					<StreamingIndicator sessionId={activeSessionId} workspaceId={workspaceId} />
				</div>
			)}

			<div>
				{totalTopLevel === 0 && !activeSessionId && (
					<p className="text-sm text-muted-foreground py-4 text-center">No activity yet</p>
				)}
				{phases.map((phase, index) => (
					<section key={`${phase.status}-${phase.startedAt ?? index}`}>
						<PhaseDivider status={phase.status} startedAt={phase.startedAt} />
						<div className="space-y-0.5">
							{phase.events.map((event) =>
								event.action === 'commented' ? (
									<ActivityComment
										key={event.id}
										event={event}
										replies={repliesByParent.get(event.id) ?? []}
										workspaceId={workspaceId}
										objectId={object.id}
									/>
								) : (
									<ActivityItem
										key={event.id}
										event={event}
										compact
										contextEntityId={object.id}
										actorsById={actorsById}
										descriptionOverride={
											event.action === 'status_changed'
												? formatStatusTransitionShort(event)
												: undefined
										}
									/>
								),
							)}
						</div>
					</section>
				))}
			</div>

			<div className="mt-4">
				<CommentInput workspaceId={workspaceId} objectId={object.id} />
			</div>
		</div>
	)
}
