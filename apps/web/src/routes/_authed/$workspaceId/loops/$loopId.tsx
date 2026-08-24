import { PageHeader } from '@/components/layout/page-header'
import { LoopActivity } from '@/components/loops/loop-activity'
import { LoopChanges } from '@/components/loops/loop-changes'
import { LoopFirstRunBanner } from '@/components/loops/loop-first-run-banner'
import { LoopFlow } from '@/components/loops/loop-flow'
import { LOOP_PILL_STYLES, isLiveLoopPill } from '@/components/loops/loop-pill'
import {
	LoopProposedEdit,
	type PlanDiffRow,
	diffLoopPlans,
	readStoredPlan,
} from '@/components/loops/loop-proposed-edit'
import { LoopStats } from '@/components/loops/loop-stats'
import { LoopSummary } from '@/components/loops/loop-summary'
import { LoopUtteranceInput } from '@/components/loops/loop-utterance-input'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActors } from '@/hooks/use-actors'
import { useEntityEvents } from '@/hooks/use-events'
import { useLoop, useLoopActivity } from '@/hooks/use-loops'
import { useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useTriggers } from '@/hooks/use-triggers'
import { cn } from '@/lib/cn'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { MoreHorizontal, Pause, Play } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

export const Route = createFileRoute('/_authed/$workspaceId/loops/$loopId')({
	component: LoopDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

interface ProposedEdit {
	/** What the operator just said — the clause, shown on the card. */
	utterance: string
	rows: PlanDiffRow[]
	nextPlan: LoopPlan
	/** The full sentence `nextPlan` was parsed from (source + clause), persisted
	 *  alongside the plan so the next refinement builds on it. */
	nextSource: string
}

function LoopDetailPage() {
	const { loopId } = Route.useParams()
	const { workspaceId, workspace } = useWorkspace()
	const {
		data: loop,
		isLoading: loopLoading,
		isError: isLoopError,
		error: loopError,
		refetch: refetchLoop,
	} = useLoop(loopId, workspaceId)
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

	const composerRef = useRef<HTMLDivElement>(null)
	const [proposedEdit, setProposedEdit] = useState<ProposedEdit | null>(null)

	const focusComposer = useCallback(() => {
		const node = composerRef.current
		if (!node) return
		node.scrollIntoView({ block: 'end', behavior: 'smooth' })
		node.querySelector('textarea')?.focus()
	}, [])

	// An utterance is read back as a diff against the plan snapshot `/loops/new`
	// wrote to `metadata.plan`. Loops without one (marketplace installs, MCP
	// creations) return false and fall through to the chat hand-off.
	const storedPlan = readStoredPlan(object?.metadata)
	// The sentence the stored plan was parsed from, written alongside it by
	// `/loops/new`.
	const planSource =
		typeof object?.metadata?.plan_source === 'string' ? object.metadata.plan_source : null
	const statusChains = (workspace.settings as { statuses?: Record<string, string[]> } | undefined)
		?.statuses
	const handleUtterance = useCallback(
		(utterance: string) => {
			if (!storedPlan) return false
			// A refinement is a clause, not a restatement — "Ask me before anything
			// ships" parsed on its own describes a different loop entirely (it names
			// no object type, so the parser falls back to Task). Append it to the
			// source sentence and re-read the whole thing, the same way the builder's
			// own refine chips extend the utterance rather than replacing it.
			const nextSource = planSource
				? `${planSource.trim().replace(/[.!?]+$/, '')} ${utterance.trim()}`
				: utterance
			const nextPlan = parseLoopDescription(nextSource, { statusChains })
			const rows = diffLoopPlans(storedPlan, nextPlan)
			if (rows.length === 0) return false
			setProposedEdit({ utterance, rows, nextPlan, nextSource })
			return true
		},
		[storedPlan, statusChains, planSource],
	)

	const applyProposedEdit = useCallback(() => {
		if (!proposedEdit) return
		updateObject.mutate(
			{
				id: loopId,
				data: {
					metadata: {
						plan: JSON.stringify(proposedEdit.nextPlan),
						// Keep the source in step with the plan, so the next refinement
						// builds on this one rather than on the original sentence.
						plan_source: proposedEdit.nextSource,
					},
				},
			},
			{
				onSuccess: () => {
					setProposedEdit(null)
					toast.success('Loop updated')
				},
				onError: () => toast.error('Could not apply that change'),
			},
		)
	}, [proposedEdit, updateObject, loopId])

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

	if (isLoopError && !loop) {
		return (
			<div className="max-w-3xl mx-auto">
				<QueryStateError
					title="Couldn't load loop"
					error={loopError ?? new Error('Something went wrong.')}
					onRetry={() => refetchLoop()}
				/>
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
	const pill = LOOP_PILL_STYLES[loop.pill]
	const isPaused = loop.status === 'paused'
	// Built but never run: no children have entered it and nothing has happened.
	const isPreFirstRun = childIds.length === 0 && (activityEvents?.length ?? 0) === 0
	const hasChanges = (events ?? []).some((e) => e.entityId === loopId)

	// Resuming returns the loop to `learning`, the lowest live rung of the
	// autonomy ladder, matching every server-side creation path
	// (installed-loops.ts, workspace-bootstrap.ts): a loop that has been paused
	// re-earns trust rather than snapping back to full autonomy. The trigger
	// re-enable is handled server-side by the status hook in
	// PATCH /api/objects/:id, so this only writes the status.
	const togglePause = () =>
		updateObject.mutate({
			id: loop.id,
			data: { status: isPaused ? 'learning' : 'paused' },
		})

	return (
		<>
			<PageHeader
				title={loop.name ?? 'Untitled loop'}
				actions={
					<>
						<span
							data-testid="loop-pill"
							className={cn(
								'inline-flex items-center gap-1.5 text-[11.5px] font-semibold',
								pill.text,
							)}
						>
							<span
								aria-hidden="true"
								className={cn(
									'size-1.5 rounded-full',
									pill.dot,
									isLiveLoopPill(loop.pill) && 'animate-pulse',
								)}
							/>
							{pill.label}
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="h-7 w-7 text-muted-foreground"
									aria-label="More"
								>
									<MoreHorizontal size={15} />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={togglePause} disabled={updateObject.isPending}>
									{isPaused ? (
										<>
											<Play size={14} /> Resume loop
										</>
									) : (
										<>
											<Pause size={14} /> Pause loop
										</>
									)}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				}
			/>
			<div className="mx-auto flex w-full max-w-3xl flex-col">
				<h1 className="text-2xl font-bold leading-tight tracking-[-0.025em] text-foreground">
					{loop.name ?? 'Untitled loop'}
				</h1>

				<div className="mt-3.5">
					<LoopSummary loop={loop} onEdit={focusComposer} />
				</div>

				{isInstalledFromMarketplace && (
					<Link
						to="/$workspaceId/marketplace"
						params={{ workspaceId }}
						className="mt-3 text-[13px] leading-[1.55] text-muted-foreground hover:text-foreground hover:underline"
					>
						Installed from marketplace
					</Link>
				)}

				<div className="mt-5">
					<LoopStats loop={loop} />
				</div>

				{isPreFirstRun && (
					<div className="mt-4">
						<LoopFirstRunBanner triggers={loopTriggers} />
					</div>
				)}

				<div className="mt-7">
					<LoopFlow
						workspaceId={workspaceId}
						triggers={loopTriggers}
						actors={actors}
						childObjects={children ?? []}
						loop={loop}
					/>
				</div>

				<div className="mt-7">
					<LoopActivity workspaceId={workspaceId} events={activityEvents} />
				</div>

				<div className="mt-7">
					<LoopChanges workspaceId={workspaceId} loopId={loop.id} events={events} />
				</div>

				<LoopUtteranceInput
					ref={composerRef}
					loop={loop}
					showSuggestions={!hasChanges && !proposedEdit}
					onUtterance={handleUtterance}
				>
					{proposedEdit && (
						<LoopProposedEdit
							utterance={proposedEdit.utterance}
							rows={proposedEdit.rows}
							nextPlan={proposedEdit.nextPlan}
							onApply={applyProposedEdit}
							onDismiss={() => setProposedEdit(null)}
							applying={updateObject.isPending}
						/>
					)}
				</LoopUtteranceInput>
			</div>
		</>
	)
}
