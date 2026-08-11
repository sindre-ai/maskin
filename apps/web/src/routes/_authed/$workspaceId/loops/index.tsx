import { PageHeader } from '@/components/layout/page-header'
import { LoopRow } from '@/components/loops/loop-row'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useLoops } from '@/hooks/use-loops'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

// "Assigned in chat" rows are agent sessions the operator kicked off directly —
// a session with no trigger is not part of an automated loop cycle, so it is
// exactly "work you handed an agent yourself, outside any cycle".
const SESSION_STATE_LABEL: Record<string, string> = {
	waiting: 'Queued',
	starting: 'Starting',
	running: 'Working',
	completed: 'Done',
	paused: 'Paused',
	failed: 'Failed',
	timeout: 'Timed out',
	cancelled: 'Cancelled',
}

function sessionStateLabel(status: string): string {
	return SESSION_STATE_LABEL[status] ?? status
}

export const Route = createFileRoute('/_authed/$workspaceId/loops/')({
	component: LoopsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function LoopsPage() {
	const { workspaceId } = useWorkspace()
	const { data: loops, isLoading: loopsLoading } = useLoops(workspaceId)
	const { data: triggers } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
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

	const hasLoops = (loops?.length ?? 0) > 0
	// Task spec: the "Not tied to a loop" section only surfaces for workspaces
	// that have both loops AND standalone triggers — a workspace with no loops
	// falls through to the empty state.
	const hasStandalone = hasLoops && standaloneTriggers.length > 0
	// Work handed an agent directly in chat — sessions with no triggering
	// automation (triggerId null) are outside any cycle. Show the most recent.
	const assignedInChat = useMemo(() => {
		if (!sessions) return []
		return sessions
			.filter((s) => s.triggerId === null && !!s.actorId)
			.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
			.slice(0, 5)
	}, [sessions])
	const hasAssignedInChat = hasLoops && assignedInChat.length > 0

	return (
		<div>
			<PageHeader title="Loops" />

			{loopsLoading ? (
				<ListSkeleton />
			) : !hasLoops ? (
				<EmptyState
					title="No loops running here yet"
					description="Loops are persistent, multi-agent processes — a named pipeline that continuously ingests work, routes it through several agents, and surfaces decisions to you. Install one from the Marketplace, or start a new one."
					action={
						<Button size="sm" variant="outline" asChild>
							<Link to="/$workspaceId/marketplace" params={{ workspaceId }}>
								Browse the Marketplace
							</Link>
						</Button>
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
					{hasAssignedInChat && (
						<section className="space-y-2">
							<div>
								<h2 className="text-sm font-medium text-foreground">Assigned in chat</h2>
								<p className="text-xs text-muted-foreground">
									Work you handed an agent yourself, outside any cycle.
								</p>
							</div>
							<div className="space-y-2">
								{assignedInChat.map((session) => {
									const agent = actors?.find((a) => a.id === session.actorId)
									return (
										<div
											key={session.id}
											className="flex items-center gap-3 rounded-lg border border-border bg-card p-4"
										>
											{agent && <ActorAvatar id={agent.id} name={agent.name} type={agent.type} />}
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2">
													<p className="text-sm font-medium text-foreground truncate">
														{agent?.name ?? 'Agent'}
													</p>
													<span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
														{sessionStateLabel(session.status)}
													</span>
												</div>
												<p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
													{session.actionPrompt}
												</p>
												<p className="text-xs text-muted-foreground/60 mt-0.5">
													{session.currentActivity ?? 'No recent activity'}
													{session.createdAt && (
														<>
															{' · '}Started <RelativeTime date={session.createdAt} />
														</>
													)}
												</p>
											</div>
										</div>
									)
								})}
							</div>
						</section>
					)}
				</div>
			)}
			<CreatePicker open={createPickerOpen} onOpenChange={setCreatePickerOpen} defaultType="loop" />
		</div>
	)
}
