import { PageHeader } from '@/components/layout/page-header'
import { AskBanner } from '@/components/loops/ask-banner'
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActors } from '@/hooks/use-actors'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useLoop, useLoopActivity, useLoopSteps } from '@/hooks/use-loops'
import { useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useTriggers } from '@/hooks/use-triggers'
import { trackAskBannerDecideClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { nextFireAt, nextFireLabel } from '@/lib/loop-next-fire'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { isWaitingOnViewer, useWaitingOnViewer } from '@maskin/shared'
import { Link, createFileRoute } from '@tanstack/react-router'
import { MoreHorizontal, Pause, Play } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

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
	// Sub-flag for D5 (bet/d166-loops-v4-polish). Off → the Targets & owners
	// section never renders even when the loop has targets, so a rollback is
	// a flag flip rather than a code change.
	const targetsFlag = useFeatureFlag('loops-v4-polish.targets')
	// D8 sub-flag boundary — read once at this route, then threaded into
	// TimelineTab as an options prop so the shared component stays flag-free
	// for Objects and every other consumer. Off preserves the pre-bet unread
	// divider so a rollback is a flag flip, not a code change.
	const unreadPolishFlag = useFeatureFlag('loops-v4-polish.unread')
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
	const { data: activityEvents } = useLoopActivity(loopId, workspaceId)
	// Loops v4 (D6c). Sub-flag gates the vertical-story renderer on this
	// route; flag off keeps the shipped `status-columns` LoopFlow variant
	// unchanged, and the extra /steps fetch never fires. One boundary at the
	// route level per the feature-flag rule (`.claude/rules/feature-flags.md`).
	const stepFlowEnabled = useFeatureFlag('loops-v4-polish.step_flow')
	const { data: loopSteps } = useLoopSteps(loopId, workspaceId, { enabled: stepFlowEnabled })
	const updateObject = useUpdateObject(workspaceId)
	// Feature-flag boundary for the loops v4 polish bet. Read once at the route
	// level per the feature-flags rule (`.claude/rules/feature-flags.md`); kept
	// above the early returns below so the hook order stays stable across renders.
	const loopsV4Enabled = useFeatureFlag('loops-v4-polish')

	const composerRef = useRef<HTMLDivElement>(null)
	const [proposedEdit, setProposedEdit] = useState<ProposedEdit | null>(null)
	const loopsV4Polish = useFeatureFlag('loops-v4-polish')

	// D3 AskBanner wiring — the shared `useWaitingOnViewer` (T1) takes a getter
	// so `packages/shared` stays React-free. When the `step_flow` sub-flag is on
	// the getter returns the real per-step array from `useLoopSteps` so the
	// banner samples the actually-stalled step. When the sub-flag is off, fall
	// back to the loop-level `waitingOnViewer` bit as a single synthetic step so
	// the banner still renders under the umbrella flag alone. Every hook the
	// banner needs is called unconditionally BEFORE the loading / error /
	// not-found early-returns so hook order is stable across renders (React
	// rules-of-hooks).
	const loopWaiting = loop?.waitingOnViewer === true
	const getLoopStepsForBanner = useCallback(() => {
		if (stepFlowEnabled) return loopSteps ?? []
		return loopWaiting ? [{ waitingOnViewer: true }] : []
	}, [stepFlowEnabled, loopSteps, loopWaiting])
	const anyStepPending = useWaitingOnViewer(loop?.id ?? '', getLoopStepsForBanner)
	const firstAgentIdForBanner = loop?.agentIds[0] ?? null
	const firstAgentActor = useMemo(
		() => (firstAgentIdForBanner ? actors?.find((a) => a.id === firstAgentIdForBanner) : undefined),
		[actors, firstAgentIdForBanner],
	)
	const firstPendingStep = useMemo(
		() => (stepFlowEnabled ? (loopSteps?.find(isWaitingOnViewer) ?? null) : null),
		[stepFlowEnabled, loopSteps],
	)
	const pendingStepCount = useMemo(() => {
		if (!stepFlowEnabled) return null
		return (loopSteps ?? []).reduce((n, s) => (isWaitingOnViewer(s) ? n + 1 : n), 0)
	}, [stepFlowEnabled, loopSteps])
	const loopIdForBanner = loop?.id ?? ''
	const askBannerVisible = loopsV4Polish && !!loop && anyStepPending
	// Real count, not a 0/1 flag — this is the dimension the bet's Won
	// condition is measured on, so a constant 1 would make every session look
	// identical in PostHog. When the step_flow sub-flag is on, count pending
	// steps from the shared predicate; otherwise fall back to the loop-level
	// waitingCount so the umbrella-only banner still emits a real number.
	const pendingCount = askBannerVisible ? (pendingStepCount ?? loop?.waitingCount ?? 0) : 0
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
	// D3 AskBanner content sourcing. When the `step_flow` sub-flag is on, sample
	// the first pending step from `useLoopSteps` for `agentName`, `askText`, and
	// the avatar so the banner surfaces the actually-stalled ask. Under the
	// umbrella flag alone (sub-flag off) the per-step feed is not fetched — fall
	// back to the loop's first agent for the copy, matching the pre-D6a wiring
	// so the banner still renders.
	const askAgentActor = firstPendingStep?.agent ?? firstAgentActor ?? null
	const askAgentName = askAgentActor?.name ?? 'This loop'
	// Copy pattern per SPEC: `{agentName} asks — {askText}`.
	const askText = firstPendingStep?.triggerActionPrompt ?? 'is waiting on your input.'
	const askAvatarType = firstPendingStep ? 'agent' : firstAgentActor?.type
	const decideJumpHref = '#loop-flow'

	const installedFromMarketplaceLoopId = object?.metadata?.installed_from_marketplace_loop_id
	const isInstalledFromMarketplace = typeof installedFromMarketplaceLoopId === 'string'

	// Best-effort derivations against the current LoopSummary shape, feeding
	// LoopStats' v4 5-tile branch:
	// - cyclesRunning: `inProgressCount` while the loop is on the live rungs of
	//   the pill ladder (learning / supervised / fully_autonomous), else 0 —
	//   matches the SPEC's "count of open cycles where pill.stateSlug === live".
	// - asksWaiting: `waitingCount` from the loop payload — the real number of
	//   child objects with unread activity for this viewer. This used to be
	//   `waitingOnViewer ? 1 : 0`, which capped the tile (and the
	//   `ask_banner_decide_clicked` dimension below) at 1 no matter how many
	//   asks were actually open.
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

				{/* Stable aria-live wrapper for the D3 AskBanner (loops-v4-polish
				    umbrella flag). The wrapper element is permanent so screen
				    readers announce the banner appearance without racing the DOM
				    swap — banner content swaps in and out of the wrapper, the
				    wrapper does not swap. Never put aria-live on the banner. */}
				{loopsV4Polish && (
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
				)}

				<div className="mt-5">
					{loopsV4Enabled ? (
						<LoopStats
							loop={loop}
							cyclesRunning={cyclesRunning}
							asksWaiting={asksWaiting}
							nextFire={nextFire}
						/>
					) : (
						<LoopStats loop={loop} />
					)}
				</div>

				{isPreFirstRun && (
					<div className="mt-4">
						<LoopFirstRunBanner triggers={loopTriggers} />
					</div>
				)}

				{targetsFlag && <TargetsAndOwners loop={loop} actors={actors} />}

				<div className="mt-7">
					<LoopFlow
						workspaceId={workspaceId}
						triggers={loopTriggers}
						actors={actors}
						childObjects={children ?? []}
						loop={loop}
						variant={stepFlowEnabled ? 'vertical-story' : 'status-columns'}
						steps={loopSteps}
					/>
				</div>

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
							loopsV4PolishUnread={unreadPolishFlag ? { loopId } : undefined}
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
