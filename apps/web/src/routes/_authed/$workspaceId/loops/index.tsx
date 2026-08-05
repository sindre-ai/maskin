import { PageHeader } from '@/components/layout/page-header'
import { LoopRow } from '@/components/loops/loop-row'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useLoops } from '@/hooks/use-loops'
import { useTriggers } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/loops/')({
	component: LoopsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function LoopsPage() {
	const { workspaceId } = useWorkspace()
	const { data: loops, isLoading: loopsLoading } = useLoops(workspaceId)
	const { data: triggers } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const [createPickerOpen, setCreatePickerOpen] = useState(false)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	const standaloneTriggers = useMemo(() => {
		if (!triggers) return []
		// A trigger is standalone iff no loop names it in metadata.trigger_ids.
		// The read API resolves loop → trigger via loop.metadata.trigger_ids, so
		// membership is expressed on the loop side. useLoops projects that as
		// agentIds, not trigger ids — so we derive tied trigger ids from any
		// loop that shares the target actor. That's a coarse heuristic; the
		// canonical membership lives on the loop's metadata, and if it becomes
		// wrong for a workspace we'd surface trigger_ids on LoopSummary. For
		// now: a trigger is tied to a loop when its targetActorId is in some
		// loop's agentIds set.
		const tiedActorIds = new Set<string>()
		for (const loop of loops ?? []) {
			for (const id of loop.agentIds) tiedActorIds.add(id)
		}
		return triggers.filter((t) => !(t.targetActorId && tiedActorIds.has(t.targetActorId)))
	}, [loops, triggers])

	const newButton = (
		<Button size="sm" className="gap-1.5" onClick={() => setCreatePickerOpen(true)}>
			<Plus size={14} />
			New
		</Button>
	)

	const hasLoops = (loops?.length ?? 0) > 0
	// Task spec: the "Not tied to a loop" section only surfaces for workspaces
	// that have both loops AND standalone triggers — a workspace with no loops
	// falls through to the empty state.
	const hasStandalone = hasLoops && standaloneTriggers.length > 0

	return (
		<div>
			<PageHeader title="Loops" actions={newButton} />

			{loopsLoading ? (
				<ListSkeleton />
			) : !hasLoops ? (
				<EmptyState
					title="No loops running here yet"
					description="Loops are persistent, multi-agent processes — a named pipeline that continuously ingests work, routes it through several agents, and surfaces decisions to you. Install one from the Marketplace, or start a new one."
					action={
						<Link
							to="/$workspaceId/marketplace"
							params={{ workspaceId }}
							className="text-xs font-medium text-accent hover:underline"
						>
							Browse the Marketplace
						</Link>
					}
				/>
			) : (
				<div className="space-y-8">
					{hasLoops && (
						<section className="space-y-2">
							<p className="text-xs text-muted-foreground">
								Persistent multi-agent pipelines running in this workspace.
							</p>
							<div className="space-y-2">
								{loops?.map((loop) => (
									<LoopRow key={loop.id} loop={loop} actors={actors} />
								))}
							</div>
						</section>
					)}
					{hasStandalone && (
						<section className="space-y-2">
							<div>
								<h2 className="text-sm font-medium text-foreground">Not tied to a loop</h2>
								<p className="text-xs text-muted-foreground">
									Workspace-wide automations that run on their own.
								</p>
							</div>
							<div className="space-y-2">
								{standaloneTriggers.map((trigger) => {
									const agent = actors?.find((a) => a.id === trigger.targetActorId)
									return (
										<TriggerRow
											key={trigger.id}
											trigger={trigger}
											workspaceId={workspaceId}
											agentName={agent?.name ?? 'Unknown'}
										/>
									)
								})}
							</div>
						</section>
					)}
				</div>
			)}
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="trigger"
			/>
		</div>
	)
}
