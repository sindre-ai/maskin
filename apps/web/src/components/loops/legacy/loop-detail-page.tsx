/**
 * Pre-v2 loop-detail-page, restored verbatim from the route body it lived in before the
 * v2 Loops/Triggers redesign. Rendered when the `new-design` flag is OFF; the
 * v2 replacement is the route component itself. This whole directory dies
 * with that flag (`.claude/rules/feature-flags.md`).
 */
import { PageHeader } from '@/components/layout/page-header'
import { LoopActivity } from '@/components/loops/legacy/loop-activity'
import { LoopChanges } from '@/components/loops/legacy/loop-changes'
import { LoopFlow } from '@/components/loops/legacy/loop-flow'
import { LoopHeader } from '@/components/loops/legacy/loop-header'
import { LoopStats } from '@/components/loops/legacy/loop-stats'
import { LoopSummary } from '@/components/loops/legacy/loop-summary'
import { LoopUtteranceInput } from '@/components/loops/legacy/loop-utterance-input'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { useActors } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useLoop, useLoopActivity } from '@/hooks/use-loops'
import { useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useTriggers } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

export function LegacyLoopDetailPage({ loopId }: { loopId: string }) {
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
	const { data: activityEvents } = useLoopActivity(loopId, workspaceId)
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
							// Resuming re-enters at `learning` rather than restoring whatever
							// stage the loop was at before pausing — a pause is worth
							// re-earning trust after, not resuming blind.
							data: { status: loop.status === 'paused' ? 'learning' : 'paused' },
						})
					}
				/>

				{isInstalledFromMarketplace && (
					<Link
						to="/$workspaceId/marketplace"
						params={{ workspaceId }}
						className="text-[13px] leading-[1.55] text-muted-foreground hover:text-foreground hover:underline"
					>
						Installed from marketplace
					</Link>
				)}

				<LoopUtteranceInput loop={loop} />

				<LoopSummary loop={loop} />

				<LoopStats loop={loop} />

				<LoopFlow
					workspaceId={workspaceId}
					triggers={loopTriggers}
					actors={actors}
					childObjects={children ?? []}
					loop={loop}
				/>

				<LoopActivity workspaceId={workspaceId} events={activityEvents} />

				<LoopChanges workspaceId={workspaceId} loopId={loop.id} events={events} />
			</div>
		</>
	)
}
