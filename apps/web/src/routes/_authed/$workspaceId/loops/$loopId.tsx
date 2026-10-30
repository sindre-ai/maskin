import { PageHeader } from '@/components/layout/page-header'
import { AskBanner } from '@/components/loops/ask-banner'
import { LoopCustomView } from '@/components/loops/loop-custom-view'
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
import { LoopUtteranceInput } from '@/components/loops/loop-utterance-input'
import { TargetsAndOwners } from '@/components/loops/targets-and-owners'
import { ObjectDetailBody } from '@/components/objects/object-detail-body'
import { TimelineTab } from '@/components/objects/timeline-tab'
import { EditableTitle } from '@/components/shared/editable-title'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActors } from '@/hooks/use-actors'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useLoop, useLoopActivity } from '@/hooks/use-loops'
import { useDeleteObject, useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useTriggers } from '@/hooks/use-triggers'
import { trackAskBannerDecideClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { nextFireAt, nextFireLabel } from '@/lib/loop-next-fire'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { useWaitingOnViewer } from '@maskin/shared'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

/** Mirrors `FLAGS.LOOP_CUSTOM_VIEW` in `apps/dev/src/lib/feature-flags.ts`. */
const LOOP_CUSTOM_VIEW_FLAG = 'loop-custom-view'

export const Route = createFileRoute('/_authed/$workspaceId/loops/$loopId')({
	component: LoopDetailRoute,
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

function LoopDetailRoute() {
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
	useDocumentTitle(loop?.name)
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
	const { data: activityEvents } = useLoopActivity(loopId, workspaceId)
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const navigate = useNavigate()

	const composerRef = useRef<HTMLDivElement>(null)
	const [proposedEdit, setProposedEdit] = useState<ProposedEdit | null>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)

	// Custom view: the one read of the flag for this page. An agent pins an HTML
	// file with set_loop_view (metadata.view_file_id); with the flag on it replaces
	// the stats and flow, and the toggle switches back. A view that cannot be shown
	// sets customFailure and the default page renders with a note; choosing
	// "Custom view" again clears it and retries.
	const customViewFlag = useFeatureFlag(LOOP_CUSTOM_VIEW_FLAG)
	const viewFileId =
		typeof object?.metadata?.view_file_id === 'string' ? object.metadata.view_file_id : null
	const hasCustomView = customViewFlag && viewFileId !== null
	const [viewMode, setViewMode] = useState<'default' | 'custom'>('custom')
	const [customFailure, setCustomFailure] = useState<string | null>(null)
	const showCustomView = hasCustomView && viewMode === 'custom' && customFailure === null

	// D3 AskBanner wiring — the shared `useWaitingOnViewer` (T1) takes a getter
	// so `packages/shared` stays React-free. The loop-level `waitingOnViewer` bit
	// is passed as a single synthetic step. Every hook the banner needs is
	// called unconditionally BEFORE the loading / error / not-found early-returns
	// so hook order is stable across renders (React rules-of-hooks).
	const loopWaiting = loop?.waitingOnViewer === true
	const getLoopStepsForBanner = useCallback(
		() => (loopWaiting ? [{ waitingOnViewer: true }] : []),
		[loopWaiting],
	)
	const anyStepPending = useWaitingOnViewer(loop?.id ?? '', getLoopStepsForBanner)
	const firstAgentIdForBanner = loop?.agentIds[0] ?? null
	const firstAgentActor = useMemo(
		() => (firstAgentIdForBanner ? actors?.find((a) => a.id === firstAgentIdForBanner) : undefined),
		[actors, firstAgentIdForBanner],
	)
	const loopIdForBanner = loop?.id ?? ''
	const askBannerVisible = !!loop && anyStepPending
	// Real count, not a 0/1 flag — this is the dimension the bet's Won
	// condition is measured on, so a constant 1 would make every session look
	// identical in PostHog. Uses the loop-level waitingCount.
	const pendingCount = askBannerVisible ? (loop?.waitingCount ?? 0) : 0
	const handleDecideClick = useCallback(() => {
		const targetEl = document.getElementById('loop-flow')
		if (targetEl) {
			targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
		}
		trackAskBannerDecideClicked({ loopId: loopIdForBanner, pendingCount })
	}, [loopIdForBanner, pendingCount])

	// Same shape as `ObjectDetailShell`'s handlers: toast, then rethrow so the
	// field reopens with the reader's draft instead of silently reverting.
	const handleUpdateTitle = useCallback(
		async (title: string) => {
			try {
				await updateObject.mutateAsync({ id: loopId, data: { title } })
			} catch (err) {
				toast.error('Could not save your changes')
				throw err
			}
		},
		[loopId, updateObject],
	)

	const handleUpdateContent = useCallback(
		async (content: string) => {
			try {
				await updateObject.mutateAsync({ id: loopId, data: { content } })
			} catch (err) {
				toast.error('Could not save your changes')
				throw err
			}
		},
		[loopId, updateObject],
	)

	// A loop IS an object, so deletion routes through the shared
	// `DELETE /api/objects/:id` — `useDeleteObject` already toasts, tracks and
	// invalidates the objects/bets caches; on success the viewer lands back on
	// `/loops` since the current route's data has just been removed. Mirrors the
	// agent-detail trash affordance restored in PR #1667.
	const handleDelete = useCallback(() => {
		deleteObject.mutate(loopId, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId/loops', params: { workspaceId } })
			},
		})
	}, [deleteObject, loopId, navigate, workspaceId])

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
	// D3 AskBanner content sourcing: the banner names the loop's first agent.
	const askAgentActor = firstAgentActor ?? null
	const askAgentName = askAgentActor?.name ?? 'This loop'
	// Copy pattern per SPEC: `{agentName} asks — {askText}`.
	const askText = 'is waiting on your input.'
	const askAvatarType = firstAgentActor?.type
	const decideJumpHref = '#loop-flow'

	const installedFromMarketplaceLoopId = object?.metadata?.installed_from_marketplace_loop_id
	const isInstalledFromMarketplace = typeof installedFromMarketplaceLoopId === 'string'

	// Best-effort derivations against the current LoopSummary shape, feeding
	// LoopStats' v4 5-tile branch:
	// - cyclesRunning: `inProgressCount` while the loop is on the live rungs of
	//   the pill ladder (learning / supervised / fully_autonomous), else 0 —
	//   matches the SPEC's "count of open cycles where pill.stateSlug === live".
	// - asksWaiting: `waitingCount` from the loop payload — the count of
	//   sessions on this loop's triggers currently in `waiting_for_input`.
	//   Same predicate the D3 AskBanner uses, so the tile and the banner never
	//   disagree (`ask_banner_decide_clicked.pendingCount` and this tile are
	//   the same number).
	// - nextFire: earliest enabled cron/reminder trigger's next firing time,
	//   formatted `in Nm`/`in Nh`/`in Nd`/an absolute date past a week out.
	const cyclesRunning = isLiveLoopPill(loop.pill) ? loop.inProgressCount : 0
	const asksWaiting = loop.waitingCount
	const nextFire = nextFireLabel(nextFireAt(loopTriggers))
	const pill = LOOP_PILL_STYLES[loop.pill]
	const isPaused = loop.status === 'paused'
	// Built but never run: no children have entered it and nothing has happened.
	const isPreFirstRun = childIds.length === 0 && (activityEvents?.length ?? 0) === 0

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
					confirmDelete ? (
						// Inline confirm mirrors the agent-detail delete affordance
						// (PR #1667) — a Radix Dialog would collide with the
						// LoopUtteranceInput at the bottom of the page on mobile.
						<div className="flex items-center gap-2">
							<span className="text-xs text-error">Delete this loop?</span>
							<Button
								variant="destructive"
								size="sm"
								onClick={handleDelete}
								disabled={deleteObject.isPending}
							>
								{deleteObject.isPending ? 'Deleting...' : 'Confirm'}
							</Button>
							<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
								Cancel
							</Button>
						</div>
					) : (
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
									<DropdownMenuItem
										onSelect={() => setConfirmDelete(true)}
										className="text-error focus:text-error"
									>
										<Trash2 size={14} /> Delete loop
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					)
				}
			/>
			<div className="mx-auto flex w-full max-w-3xl flex-col">
				<EditableTitle
					value={loop.name}
					entityId={loop.id}
					onChange={object ? handleUpdateTitle : undefined}
					ariaLabel="Loop title"
					placeholder="Untitled loop"
				/>

				{/* The loop's promise, written the same way an object's document body
				    is — the description IS the summary now. */}
				{object && (
					<ObjectDetailBody
						object={object}
						workspaceId={workspaceId}
						onContentChange={handleUpdateContent}
					/>
				)}

				{isInstalledFromMarketplace && (
					<Link
						to="/$workspaceId/marketplace"
						params={{ workspaceId }}
						className="mt-3 text-[13px] leading-[1.55] text-muted-foreground hover:text-foreground hover:underline"
					>
						Installed from marketplace
					</Link>
				)}

				{/* Stable aria-live wrapper for the D3 AskBanner. The wrapper element
				    is permanent so screen readers announce the banner appearance
				    without racing the DOM swap — banner content swaps in and out of
				    the wrapper, the wrapper does not swap. Never put aria-live on
				    the banner. */}
				<div
					aria-live="polite"
					aria-atomic="true"
					data-testid="ask-banner-live-region"
					className={cn('mt-5', askBannerVisible ? '' : 'sr-only')}
				>
					{askBannerVisible && (
						<AskBanner
							agentName={askAgentName}
							askText={askText}
							jumpHref={decideJumpHref}
							onDecideClick={handleDecideClick}
							pendingCount={pendingCount}
							avatarId={askAgentActor?.id}
							avatarType={askAvatarType}
						/>
					)}
				</div>

				{hasCustomView && (
					<div className="mt-5 flex flex-wrap items-center justify-between gap-2">
						<p className="text-xs text-muted-foreground">
							{viewMode === 'custom' && customFailure
								? `Custom view unavailable: ${customFailure} Showing the default page.`
								: ''}
						</p>
						<ButtonGroup aria-label="Loop view">
							<Button
								type="button"
								variant={viewMode === 'default' ? 'secondary' : 'ghost'}
								size="sm"
								onClick={() => setViewMode('default')}
							>
								Default
							</Button>
							<Button
								type="button"
								variant={viewMode === 'custom' ? 'secondary' : 'ghost'}
								size="sm"
								onClick={() => {
									setCustomFailure(null)
									setViewMode('custom')
								}}
							>
								Custom view
							</Button>
						</ButtonGroup>
					</div>
				)}

				<div className="mt-5">
					{showCustomView && viewFileId ? (
						<LoopCustomView
							workspaceId={workspaceId}
							fileId={viewFileId}
							onFailure={setCustomFailure}
						/>
					) : (
						<LoopStats
							loop={loop}
							cyclesRunning={cyclesRunning}
							asksWaiting={asksWaiting}
							nextFire={nextFire}
						/>
					)}
				</div>

				{isPreFirstRun && (
					<div className="mt-4">
						<LoopFirstRunBanner triggers={loopTriggers} />
					</div>
				)}

				<TargetsAndOwners loop={loop} actors={actors} />

				{!showCustomView && (
					<div className="mt-7">
						<LoopFlow
							workspaceId={workspaceId}
							triggers={loopTriggers}
							actors={actors}
							childObjects={children ?? []}
							loop={loop}
						/>
					</div>
				)}

				{/* The same Activity block object detail carries (mockup 1138–1143):
				    a mono micro-heading on a hairline rule, then the shared timeline.
				    A loop is an object, so this is the object's own event stream. */}
				{object && (
					<div className="mt-9">
						<div className="flex items-center gap-2.5">
							<span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
								Activity
							</span>
							<div className="h-px flex-1 bg-muted" />
						</div>
						<TimelineTab
							object={object}
							loopUnread={{ loopId }}
							additionalEvents={activityEvents}
						/>
					</div>
				)}

				<LoopUtteranceInput
					ref={composerRef}
					loop={loop}
					showSuggestions={!proposedEdit}
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
