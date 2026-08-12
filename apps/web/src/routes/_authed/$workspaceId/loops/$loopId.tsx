import { ObjectActivity } from '@/components/activity/object-activity'
import { PageHeader } from '@/components/layout/page-header'
import { LoopFlow } from '@/components/loops/loop-flow'
import { LoopHeader } from '@/components/loops/loop-header'
import { LoopStats } from '@/components/loops/loop-stats'
import { LoopUtteranceInput } from '@/components/loops/loop-utterance-input'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { useActors } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useLoop } from '@/hooks/use-loops'
import { useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useTriggers } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

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
	const { data: membershipEdges } = useRelationships(workspaceId, {
		source_id: loopId,
		type: LOOP_MEMBERSHIP_RELATIONSHIP_TYPE,
	})
	const childIds = (membershipEdges ?? []).map((r) => r.targetId)
	const { data: children } = useObjects(
		workspaceId,
		{ ids: childIds.join(',') },
		{ enabled: childIds.length > 0 },
	)
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
	const installedFromMarketplaceLoopId = object?.metadata?.installed_from_marketplace_loop_id
	const isInstalledFromMarketplace = typeof installedFromMarketplaceLoopId === 'string'

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

				{isInstalledFromMarketplace && (
					<Link
						to="/$workspaceId/marketplace"
						params={{ workspaceId }}
						className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
					>
						Installed from marketplace
					</Link>
				)}

				<LoopUtteranceInput loop={loop} />

				<LoopStats loop={loop} />

				<LoopFlow
					workspaceId={workspaceId}
					triggers={loopTriggers}
					actors={actors}
					childObjects={children ?? []}
				/>

				{object && (
					<div>
						<ObjectActivity workspaceId={workspaceId} object={object} events={events} />
					</div>
				)}
			</div>
		</>
	)
}
