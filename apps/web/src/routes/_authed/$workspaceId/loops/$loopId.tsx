import { PageHeader } from '@/components/layout/page-header'
import { AskBanner } from '@/components/loops/ask-banner'
import { LoopBlockError } from '@/components/loops/loop-block-error'
import { itemsNeedingYou } from '@/components/loops/loop-counters'
import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { LoopDetailTabs } from '@/components/loops/loop-detail-tabs'
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
import { LoopTags } from '@/components/loops/loop-tags'
import { LoopUtteranceInput } from '@/components/loops/loop-utterance-input'
import { TargetsAndOwners } from '@/components/loops/targets-and-owners'
import { ObjectDetailBody } from '@/components/objects/object-detail-body'
import { TimelineTab } from '@/components/objects/timeline-tab'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EditableTitle } from '@/components/shared/editable-title'
import { EmptyState } from '@/components/shared/empty-state'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useLoadFailed } from '@/hooks/use-load-failed'
import { useLoop, useLoopActivity } from '@/hooks/use-loops'
import { useNotifications } from '@/hooks/use-notifications'
import { useDeleteObject, useObject, useObjects, useUpdateObject } from '@/hooks/use-objects'
import { useRelationships } from '@/hooks/use-relationships'
import { useCreateTrigger, useTriggers } from '@/hooks/use-triggers'
import { trackAskBannerDecideClicked, trackLoopViewed } from '@/lib/analytics'
import { api } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { nextFireAt, nextFireLabel } from '@/lib/loop-next-fire'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { useWaitingOnViewer } from '@maskin/shared'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

const SLOW_LOAD_MESSAGE = 'The server may be busy.'

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

function SetupBlock({ label, text }: { label: string; text: string | null }) {
	return (
		<section className="flex flex-col gap-2">
			<span className="font-mono text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
				{label}
			</span>
			<p className="text-[14px] leading-[1.55] text-foreground">
				{text?.trim() ? text : 'Not set yet.'}
			</p>
		</section>
	)
}

function LoopDetailRoute() {
	const { loopId } = Route.useParams()
	const { workspaceId, workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const {
		data: loop,
		isLoading: loopLoading,
		isError: isLoopError,
		error: loopError,
		refetch: refetchLoop,
	} = useLoop(loopId, workspaceId)
	const objectQuery = useObject(loopId)
	const { data: object } = objectQuery
	useDocumentTitle(loop?.name)
	// One event per open of a loop page. Keyed on the id so refetches and
	// StrictMode's double effect do not repeat it.
	const viewedLoopRef = useRef<string | null>(null)
	const viewedLoopId = loop?.id ?? null
	useEffect(() => {
		if (!viewedLoopId || viewedLoopRef.current === viewedLoopId) return
		viewedLoopRef.current = viewedLoopId
		trackLoopViewed({ entity_id: viewedLoopId })
	}, [viewedLoopId])
	const triggersQuery = useTriggers(workspaceId)
	const { data: triggers } = triggersQuery
	const actorsQuery = useActors(workspaceId)
	const { data: actors } = actorsQuery
	const edgesQuery = useRelationships(workspaceId, {
		source_id: loopId,
		type: LOOP_MEMBERSHIP_RELATIONSHIP_TYPE,
	})
	const { data: membershipEdges } = edgesQuery
	const childIds = (membershipEdges ?? []).map((r) => r.targetId)
	const childrenQuery = useObjects(
		workspaceId,
		{ ids: childIds.join(',') },
		{ enabled: childIds.length > 0 },
	)
	const { data: children } = childrenQuery
	const activityQuery = useLoopActivity(loopId, workspaceId)
	const { data: activityEvents } = activityQuery
	const { data: needsInputNotifications } = useNotifications(workspaceId, { type: 'needs_input' })
	// A block whose calls fail, or stay unanswered for 30 s, says so with a retry instead of
	// rendering empty. Each block judges only its own calls, so one slow call does not blank
	// the others. Called before the early returns so hook order stays stable.
	const loopFailed = useLoadFailed({ data: loop, isLoading: loopLoading, isError: isLoopError })
	const objectFailed = useLoadFailed(objectQuery)
	const triggersFailed = useLoadFailed(triggersQuery)
	const actorsFailed = useLoadFailed(actorsQuery)
	const edgesFailed = useLoadFailed(edgesQuery)
	const childrenFailed = useLoadFailed(childrenQuery)
	const activityFailed = useLoadFailed(activityQuery)
	const flowFailed = triggersFailed || actorsFailed || edgesFailed || childrenFailed
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const navigate = useNavigate()

	const composerRef = useRef<HTMLDivElement>(null)
	const [proposedEdit, setProposedEdit] = useState<ProposedEdit | null>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const [tab, setTab] = useState('overview')

	// Custom view: an agent pins an HTML file with set_loop_view
	// (metadata.view_file_id); it replaces the stats and flow, and the toggle
	// switches back. A view that cannot be shown sets customFailure and the
	// default page renders with a note; choosing "Custom view" again clears it
	// and retries.
	const viewFileId =
		typeof object?.metadata?.view_file_id === 'string' ? object.metadata.view_file_id : null
	const hasCustomView = viewFileId !== null
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

	const createTrigger = useCreateTrigger(workspaceId)
	const loopTriggerIds = loop?.triggerIds
	const loopAgentIds = loop?.agentIds
	const addingTriggerRef = useRef(false)
	const [addingTrigger, setAddingTrigger] = useState(false)
	// A new trigger starts paused with placeholder settings, tied to this flow, and opens on
	// its own page to be filled in — the same start the create picker gives a trigger.
	const handleAddTrigger = useCallback(async () => {
		if (addingTriggerRef.current) return
		const actorId = getStoredActor()?.id
		if (!actorId) {
			toast.error('Sign in required to add a trigger')
			return
		}
		addingTriggerRef.current = true
		setAddingTrigger(true)
		let createdId: string | null = null
		try {
			const created = await createTrigger.mutateAsync({
				name: 'New trigger',
				type: 'cron',
				config: { expression: '0 0 * * *' },
				action_prompt: 'New trigger',
				// The flow's own first agent when it has one, so the new step lands in a column
				// that exists; the person adding it otherwise, as the create picker does.
				target_actor_id: loopAgentIds?.[0] ?? actorId,
				enabled: false,
			})
			createdId = created.id
			await updateObject.mutateAsync({
				id: loopId,
				data: { metadata: { trigger_ids: [...(loopTriggerIds ?? []), created.id] } },
			})
			navigate({
				to: '/$workspaceId/triggers/$triggerId',
				params: { workspaceId, triggerId: created.id },
			})
		} catch {
			// A trigger that never got tied to the flow would sit loose in the workspace.
			if (createdId) api.triggers.delete(createdId, workspaceId).catch(() => {})
			toast.error('Could not add a trigger')
		} finally {
			addingTriggerRef.current = false
			setAddingTrigger(false)
		}
	}, [createTrigger, updateObject, loopId, loopTriggerIds, loopAgentIds, navigate, workspaceId])

	const handleUpdateTags = useCallback(
		async (tags: string[]) => {
			try {
				await updateObject.mutateAsync({ id: loopId, data: { metadata: { tags } } })
			} catch {
				toast.error('Could not save your changes')
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
		if (!canWrite) return
		deleteObject.mutate(loopId, {
			onSuccess: () => {
				navigate({ to: '/$workspaceId/loops', params: { workspaceId } })
			},
		})
	}, [deleteObject, loopId, navigate, workspaceId, canWrite])

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
		if (!proposedEdit || !canWrite) return
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
					// Undo re-applies the values the edit replaced. 30 s is long enough
					// to notice a wrong read-back, short enough that it never silently
					// reverts later changes.
					const previous = object?.metadata
					toast.success('Flow updated', {
						duration: 30_000,
						action: previous
							? {
									label: 'Undo',
									onClick: () =>
										updateObject.mutate(
											{
												id: loopId,
												data: {
													metadata: {
														plan: typeof previous.plan === 'string' ? previous.plan : '',
														plan_source:
															typeof previous.plan_source === 'string' ? previous.plan_source : '',
													},
												},
											},
											{
												onSuccess: () => toast.success('Change undone'),
												onError: () => toast.error('Could not undo that change'),
											},
										),
								}
							: undefined,
					})
				},
				onError: () => toast.error('Could not apply that change'),
			},
		)
	}, [proposedEdit, updateObject, loopId, canWrite, object?.metadata])

	if (loopFailed) {
		return (
			<div className="max-w-3xl mx-auto">
				<QueryStateError
					title="Couldn't load flow"
					error={loopError ?? new Error(SLOW_LOAD_MESSAGE)}
					onRetry={() => refetchLoop()}
				/>
			</div>
		)
	}

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
					title="Flow not found"
					description="This flow may have been deleted or you don't have access to it."
				/>
			</div>
		)
	}

	const loopTriggers = (triggers ?? []).filter((t) => loop.triggerIds.includes(t.id))
	// D3 AskBanner content sourcing: the banner names the loop's first agent.
	const askAgentActor = firstAgentActor ?? null
	const askAgentName = askAgentActor?.name ?? 'This flow'
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
	// The flow's driver is the object's own `driver`; no driver, no pill.
	const driver = object?.driver ? actors?.find((a) => a.id === object.driver) : undefined
	const needsYouRows = itemsNeedingYou(
		children ?? [],
		needsInputNotifications ?? [],
		getStoredActor()?.id,
	)
	const sortedChildren = [...(children ?? [])].sort((a, b) =>
		(a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base', numeric: true }),
	)
	const isPaused = loop.status === 'paused'
	// Built but never run: no children have entered it and nothing has happened.
	// Unknown is not empty: when the membership or activity call failed, say nothing.
	const isPreFirstRun =
		childIds.length === 0 && (activityEvents?.length ?? 0) === 0 && !edgesFailed && !activityFailed

	// Resuming returns the loop to `learning`, the lowest live rung of the
	// autonomy ladder, matching every server-side creation path
	// (installed-loops.ts, workspace-bootstrap.ts): a loop that has been paused
	// re-earns trust rather than snapping back to full autonomy. The trigger
	// re-enable is handled server-side by the status hook in
	// PATCH /api/objects/:id, so this only writes the status.
	const togglePause = () => {
		if (!canWrite) return
		updateObject.mutate({
			id: loop.id,
			data: { status: isPaused ? 'learning' : 'paused' },
		})
	}

	return (
		<>
			<PageHeader
				title={loop.name ?? 'Untitled flow'}
				actions={
					confirmDelete ? (
						// Inline confirm mirrors the agent-detail delete affordance
						// (PR #1667) — a Radix Dialog would collide with the
						// LoopUtteranceInput at the bottom of the page on mobile.
						<div className="flex items-center gap-2">
							<span className="text-xs text-error">Delete this flow?</span>
							<ViewerTooltip>
								<Button
									variant="destructive"
									size="sm"
									onClick={handleDelete}
									disabled={deleteObject.isPending || !canWrite}
								>
									{deleteObject.isPending ? 'Deleting...' : 'Confirm'}
								</Button>
							</ViewerTooltip>
							<Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
								Cancel
							</Button>
						</div>
					) : (
						<>
							<DropdownMenu>
								<ViewerTooltip>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="h-7 w-7 text-muted-foreground"
											aria-label="More"
											disabled={!canWrite}
										>
											<MoreHorizontal size={15} />
										</Button>
									</DropdownMenuTrigger>
								</ViewerTooltip>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onSelect={togglePause}
										disabled={updateObject.isPending || !canWrite}
									>
										{isPaused ? (
											<>
												<Play size={14} /> Resume flow
											</>
										) : (
											<>
												<Pause size={14} /> Pause flow
											</>
										)}
									</DropdownMenuItem>
									<DropdownMenuItem
										onSelect={() => setConfirmDelete(true)}
										disabled={!canWrite}
										className="text-error focus:text-error"
									>
										<Trash2 size={14} /> Delete flow
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					)
				}
			/>
			<div className="flex w-full min-w-0 flex-col">
				<EditableTitle
					value={loop.name}
					entityId={loop.id}
					onChange={object && canWrite ? handleUpdateTitle : undefined}
					ariaLabel="Flow title"
					placeholder="Untitled flow"
					className="text-[clamp(24px,3vw,33px)]"
				/>

				{/* The loop's promise, written the same way an object's document body
				    is — the description IS the summary now. */}
				{object && (
					// Pulled up under the title, as the prototype sets the promise close to it.
					<div className="-mt-4 [&_p]:text-base [&_p]:leading-[1.45]">
						<ObjectDetailBody
							object={object}
							workspaceId={workspaceId}
							onContentChange={handleUpdateContent}
						/>
					</div>
				)}
				{objectFailed && (
					<LoopBlockError
						className="mt-4"
						message={`Couldn't load the description. ${SLOW_LOAD_MESSAGE}`}
						onRetry={() => objectQuery.refetch?.()}
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

				<div className="mt-4 flex flex-wrap items-center gap-2">
					<span
						data-testid="loop-pill"
						className="inline-flex h-9 items-center gap-2 rounded-full border border-border px-3.5 text-[13.5px] font-semibold text-foreground"
					>
						<span
							aria-hidden="true"
							className={cn(
								'size-2 rounded-full',
								pill.dot,
								isLiveLoopPill(loop.pill) && 'animate-pulse',
							)}
						/>
						{LOOP_PILL_STYLES[loop.status].label}
					</span>
					{driver && (
						<span
							data-testid="loop-driver"
							className="inline-flex h-9 items-center gap-2 rounded-full border border-border px-3.5 text-[13.5px]"
						>
							<ActorAvatar id={driver.id} name={driver.name} type={driver.type} />
							<span className="font-semibold text-foreground">{driver.name}</span>
							<span className="text-muted-foreground">drives</span>
						</span>
					)}
					{asksWaiting > 0 && (
						<span
							data-testid="loop-decisions-chip"
							className="inline-flex h-9 items-center rounded-full border border-border px-3.5 text-[13.5px] font-semibold text-foreground"
						>
							{asksWaiting === 1 ? '1 decision needed' : `${asksWaiting} decisions needed`}
						</span>
					)}
					<LoopTags tags={loop.tags} canWrite={canWrite && !!object} onChange={handleUpdateTags} />
				</div>

				<div className="mt-6">
					<LoopDetailTabs
						tabs={[
							{ value: 'overview', label: 'Overview', count: asksWaiting },
							{ value: 'items', label: 'Items', count: childIds.length },
							{ value: 'activity', label: 'Activity' },
							{ value: 'setup', label: 'Setup' },
						]}
						value={tab}
						onChange={setTab}
					/>
				</div>

				{tab === 'overview' && (
					<div role="tabpanel" className="mt-8 flex flex-col gap-8">
						{/* Stable aria-live wrapper for the D3 AskBanner. The wrapper element
				    is permanent so screen readers announce the banner appearance
				    without racing the DOM swap — banner content swaps in and out of
				    the wrapper, the wrapper does not swap. Never put aria-live on
				    the banner. */}
						<div
							aria-live="polite"
							aria-atomic="true"
							data-testid="ask-banner-live-region"
							className={cn(askBannerVisible ? '' : 'sr-only')}
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

						{isPreFirstRun && (
							<div>
								<LoopFirstRunBanner triggers={loopTriggers} />
							</div>
						)}

						<TargetsAndOwners loop={loop} actors={actors} />

						{hasCustomView && (
							<div
								className={cn(
									'flex flex-wrap items-center justify-between gap-2',
									// The view sits right under its switch, not a whole section away.
									showCustomView && '-mb-4',
								)}
							>
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

						{showCustomView && viewFileId && (
							// One block, so the "Updated" line and the view are not spaced as sections.
							<div className="min-w-0">
								<LoopCustomView
									workspaceId={workspaceId}
									fileId={viewFileId}
									onFailure={setCustomFailure}
								/>
							</div>
						)}

						{!showCustomView && (
							<>
								{needsYouRows.length > 0 && (
									<section
										aria-label="Decisions"
										data-testid="loop-needs-you"
										className="flex flex-col"
									>
										<span className="text-[13px] font-semibold text-muted-foreground">
											Decisions
										</span>
										<p className="mt-2 text-[14px] font-semibold text-foreground">
											{needsYouRows.length === 1
												? '1 item is waiting for you'
												: `${needsYouRows.length} items are waiting for you`}
										</p>
										{needsYouRows.map(({ item, ask }) => (
											<Link
												key={item.id}
												to="/$workspaceId/objects/$objectId"
												params={{ workspaceId, objectId: item.id }}
												className="mt-2 flex flex-col gap-0.5 rounded-lg border border-border px-3 py-2.5 transition-colors duration-150 hover:bg-muted"
											>
												<span className="truncate text-[14px] font-semibold text-foreground">
													{item.title ?? 'Untitled'}
												</span>
												<span className="truncate text-[12.5px] text-muted-foreground">
													{ask.title}
												</span>
											</Link>
										))}
									</section>
								)}

								<div>
									{flowFailed ? (
										<LoopBlockError
											message={`Couldn't load the steps of this flow. ${SLOW_LOAD_MESSAGE}`}
											onRetry={() => {
												for (const [failed, query] of [
													[triggersFailed, triggersQuery],
													[actorsFailed, actorsQuery],
													[edgesFailed, edgesQuery],
													[childrenFailed, childrenQuery],
												] as const) {
													if (failed) query.refetch?.()
												}
											}}
										/>
									) : (
										<LoopFlow
											workspaceId={workspaceId}
											triggers={loopTriggers}
											actors={actors}
											loop={loop}
											onAddTrigger={canWrite && object ? handleAddTrigger : undefined}
											addingTrigger={addingTrigger}
										/>
									)}
								</div>
							</>
						)}
					</div>
				)}

				{tab === 'items' && (
					<div role="tabpanel" className="mt-8 flex flex-col">
						{sortedChildren.length === 0 ? (
							<EmptyState
								title="No items in this flow yet"
								description="Items show up here once the flow starts working on them."
							/>
						) : (
							sortedChildren.map((child) => (
								<Link
									key={child.id}
									to="/$workspaceId/objects/$objectId"
									params={{ workspaceId, objectId: child.id }}
									className="flex items-center gap-3 border-b border-border px-1 py-3 transition-colors duration-150 hover:bg-muted"
								>
									<TypeBadge type={child.type} variant="dot" />
									<span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">
										{child.title ?? 'Untitled'}
									</span>
									<StatusBadge status={child.status} variant="word" className="text-[12px]" />
								</Link>
							))
						)}
					</div>
				)}

				{tab === 'activity' && object && (
					<div role="tabpanel" className="mt-8">
						{activityFailed && (
							<LoopBlockError
								className="mb-3"
								message={`Couldn't load the flow's recent activity. ${SLOW_LOAD_MESSAGE}`}
								onRetry={() => activityQuery.refetch?.()}
							/>
						)}
						<TimelineTab
							object={object}
							loopUnread={{ loopId }}
							additionalEvents={activityEvents}
						/>
					</div>
				)}

				{tab === 'setup' && (
					<div role="tabpanel" className="mt-8 flex flex-col gap-8">
						<LoopStats
							loop={loop}
							cyclesRunning={cyclesRunning}
							asksWaiting={asksWaiting}
							nextFire={nextFire}
						/>
						<SetupBlock label="Starts when" text={loop.entryCondition} />
						<SetupBlock label="Ends when" text={loop.closeCondition} />
						<section className="flex flex-col gap-3">
							<span className="font-mono text-[10px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
								Agents
							</span>
							{loop.agentIds.length === 0 ? (
								<p className="text-[13px] text-muted-foreground">No agents are attached yet.</p>
							) : (
								loop.agentIds.map((id) => {
									const agent = actors?.find((a) => a.id === id)
									if (!agent) return null
									return (
										<Link
											key={id}
											to="/$workspaceId/agents/$agentId"
											params={{ workspaceId, agentId: id }}
											className="flex items-center gap-2.5 text-[14px] font-semibold text-foreground hover:underline"
										>
											<ActorAvatar id={agent.id} name={agent.name} type={agent.type} />
											{agent.name}
										</Link>
									)
								})
							)}
						</section>
					</div>
				)}

				<LoopUtteranceInput
					ref={composerRef}
					loop={loop}
					placeholder={
						driver ? `Message ${driver.name}, who drives ${loop.name ?? 'this flow'}` : undefined
					}
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
