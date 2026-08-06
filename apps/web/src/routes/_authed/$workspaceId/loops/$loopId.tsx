import { ObjectActivity } from '@/components/activity/object-activity'
import { PageHeader } from '@/components/layout/page-header'
import { LoopHeader } from '@/components/loops/loop-header'
import { LoopPipeline } from '@/components/loops/loop-pipeline'
import { LoopStats } from '@/components/loops/loop-stats'
import { LoopSteps } from '@/components/loops/loop-steps'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useLoop } from '@/hooks/use-loops'
import { useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useTriggers } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authed/$workspaceId/loops/$loopId')({
	component: LoopDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function LoopDetailPage() {
	const { loopId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: loop, isLoading: loopLoading } = useLoop(loopId, workspaceId)
	const { data: object } = useObject(loopId)
	const { data: triggers } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: children } = useObjects(workspaceId, { 'metadata.loop_id': loopId })
	const { data: events } = useEntityEvents(workspaceId, loopId)
	const updateObject = useUpdateObject(workspaceId)

	if (loopLoading && !loop) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (!loop) {
		return (
			<div className="max-w-3xl mx-auto">
				<EmptyState
					title="Loop not found"
					description="This loop may have been deleted or you don't have access to it."
				/>
			</div>
		)
	}

	const loopTriggers = (triggers ?? []).filter((t) => loop.triggerIds.includes(t.id))

	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto space-y-6">
				<LoopHeader
					loop={loop}
					isTogglingPause={updateObject.isPending}
					onTogglePause={() =>
						updateObject.mutate({
							id: loop.id,
							data: { status: loop.status === 'paused' ? 'running' : 'paused' },
						})
					}
				/>

				<LoopStats loop={loop} />

				<LoopSteps
					triggers={loopTriggers}
					actors={actors}
					triggerCount={loop.triggerIds.length}
					agentCount={loop.agentIds.length}
				/>

				<LoopPipeline workspaceId={workspaceId} loopId={loop.id} childObjects={children ?? []} />

				{object && (
					<div>
						<ObjectActivity workspaceId={workspaceId} object={object} events={events} />
					</div>
				)}
			</div>
		</>
	)
}
