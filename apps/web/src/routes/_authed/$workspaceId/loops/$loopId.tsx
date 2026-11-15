import { PageHeader } from '@/components/layout/page-header'
import { AskBanner } from '@/components/loops/ask-banner'
import { LoopBlockError } from '@/components/loops/loop-block-error'
import { LoopBriefingTab } from '@/components/loops/loop-briefing-tab'
import { itemsNeedingYou } from '@/components/loops/loop-counters'
import { LoopDecisions } from '@/components/loops/loop-decisions'
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
import { LoopViewTab } from '@/components/loops/loop-view-tab'
import { TargetsAndOwners } from '@/components/loops/targets-and-owners'
import { ListView } from '@/components/objects/list/list-view'
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActors } from '@/hooks/use-actors'
import { useLoopBriefingPages } from '@/hooks/use-briefings'
import { useCanWrite } from '@/hooks/use-can-write'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useLoadFailed } from '@/hooks/use-load-failed'
import {
	useLoop,
	useLoopActivity,
	useLoopMembership,
	useLoops,
	useObjectsByIds,
} from '@/hooks/use-loops'
import { useNotifications } from '@/hooks/use-notifications'
import { useDeleteObject, useObject, useUpdateObject } from '@/hooks/use-objects'
import { useCreateTrigger, useTriggers } from '@/hooks/use-triggers'
import { trackAskBannerDecideClicked, trackLoopViewed } from '@/lib/analytics'
import { api } from '@/lib/api'
import type { LoopSummary } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { nextFireAt, nextFireLabel } from '@/lib/loop-next-fire'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import {
	type LoopStatus,
	applyLoopView,
	readLoopViews,
	toLoopViewsMetadata,
	useWaitingOnViewer,
} from '@maskin/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import type { GroupingState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { Check, ChevronDown, MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

/** Relationship type marking loop membership — mirrors
 * `LOOP_MEMBERSHIP_RELATIONSHIP_TYPE` in `apps/dev/src/routes/loops.ts`.
 * Source is the loop, target is the child object. */
const LOOP_MEMBERSHIP_RELATIONSHIP_TYPE = 'in_loop'

const NO_IDS: readonly string[] = []

const ITEMS_GROUPING: GroupingState = ['status']
const ITEMS_COLUMNS: VisibilityState = {}

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

const LOOP_STAGES = [
	'learning',
	'supervised',
	'fully_autonomous',
] as const satisfies readonly LoopStatus[]

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
	// Every item in the flow and every file attached to it, not just the first page of each.
	const edgesQuery = useLoopMembership(workspaceId, loopId)
	const { data: membership } = edgesQuery
	const childIds = membership?.itemIds ?? NO_IDS
	const childrenQuery = useObjectsByIds(workspaceId, childIds)
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
	// How the flow runs needs only its triggers and agents.
	const flowFailed = triggersFailed || actorsFailed
	const queryClient = useQueryClient()
	const updateObject = useUpdateObject(workspaceId)
	const deleteObject = useDeleteObject(workspaceId)
	const navigate = useNavigate()

	const composerRef = useRef<HTMLDivElement>(null)
	const [proposedEdit, setProposedEdit] = useState<ProposedEdit | null>(null)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const [itemSelection, setItemSelection] = useState<RowSelectionState>({})
	const [itemGroupsOpen, setItemGroupsOpen] = useState<Record<string, boolean>>({})
	const [tab, setTab] = useState('overview')

	// Custom views: an agent pins HTML files with set_loop_view
	// (metadata.views). Each is its own tab, ahead of the built-in tabs. A tab
	// that is no longer there falls back to Overview.
	const views = useMemo(() => readLoopViews(object?.metadata), [object?.metadata])
	const allViewTabs = useMemo(
		() => views.map((view, i) => ({ ...view, value: `view-${i}` })),
		[views],
	)
	// The flow has one briefing tab. It holds every briefing page attached to the flow and any
	// pinned view that is a briefing, latest first, so a pinned "Briefing" view is not a second tab.
	const briefingFileIds = useMemo(
		() => [...(membership?.fileIds ?? NO_IDS), ...views.map((view) => view.fileId)],
		[membership?.fileIds, views],
	)
	const briefingPages = useLoopBriefingPages(workspaceId, briefingFileIds)
	const briefingPageIds = useMemo(() => new Set(briefingPages.map((b) => b.id)), [briefingPages])
	const pinnedBriefing = allViewTabs.find((v) => briefingPageIds.has(v.fileId))
	const viewTabs = useMemo(
		() => allViewTabs.filter((v) => !briefingPageIds.has(v.fileId)),
		[allViewTabs, briefingPageIds],
	)
	const activeView = viewTabs.find((v) => v.value === tab)
	const hasBriefings = briefingPages.length > 0
	const activeTab =
		tab === 'overview' ||
		['items', 'activity', 'setup'].includes(tab) ||
		activeView ||
		(tab === 'briefings' && hasBriefings)
			? tab
			: 'overview'

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
		const targetEl = document.getElementById('loop-decisions')
		// The banner can show before the Decisions card has rows; fall back to the composer.
		const target = targetEl ?? composerRef.current
		target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
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
	const driverId = object?.driver ?? undefined
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

	// Renaming or removing a view rewrites the flow's `metadata.views`, leaving the file itself
	// alone. The list is re-read first: an agent may have pinned a view since the page loaded,
	// and the server replaces the array wholesale.
	const saveViews = useCallback(
		async (
			change: (current: typeof views) => typeof views | null,
			failure: string,
		): Promise<typeof views | null> => {
			try {
				const fresh = await objectQuery.refetch?.()
				const current = readLoopViews(fresh?.data?.metadata ?? object?.metadata)
				const next = change(current)
				if (!next) return null
				await updateObject.mutateAsync({
					id: loopId,
					// The API takes `{ name, file_id }` rows here; the client's metadata type is narrower.
					data: { metadata: { views: toLoopViewsMetadata(next) as never } },
				})
				return current
			} catch {
				toast.error(failure)
				return null
			}
		},
		[loopId, updateObject, objectQuery, object?.metadata],
	)
	// Resolves true once saved, so the rename field stays open (with the typed name) otherwise.
	const handleRenameView = useCallback(
		async (fileId: string, name: string) => {
			const saved = await saveViews((current) => {
				if (
					current.some((v) => v.fileId !== fileId && v.name.toLowerCase() === name.toLowerCase())
				) {
					toast.error('Another view already has that name')
					return null
				}
				return current.map((v) => (v.fileId === fileId ? { ...v, name } : v))
			}, 'Could not rename the view')
			return saved !== null
		},
		[saveViews],
	)
	const handleRemoveView = useCallback(
		async (fileId: string) => {
			const previous = await saveViews(
				(current) => current.filter((v) => v.fileId !== fileId),
				'Could not remove the view',
			)
			if (!previous) return
			setTab('overview')
			toast.success('View removed', {
				duration: 15_000,
				action: {
					label: 'Undo',
					onClick: () =>
						updateObject.mutate(
							{ id: loopId, data: { metadata: { views: toLoopViewsMetadata(previous) as never } } },
							{ onError: () => toast.error('Could not restore the view') },
						),
				},
			})
		},
		[saveViews, updateObject, loopId],
	)

	// The first agent among the flow's driver and agents: only an agent can build a view.
	const viewBuilder = useMemo(() => {
		const candidates = [driverId, ...(loopAgentIds ?? [])]
		for (const id of candidates) {
			const actor = id ? actors?.find((a) => a.id === id) : undefined
			if (actor?.type === 'agent') return actor
		}
		return undefined
	}, [driverId, loopAgentIds, actors])

	// "+" next to the views: ask the flow's driver for a new one, in a chat about this flow.
	const handleNewView = useCallback(() => {
		if (!viewBuilder) return
		navigate({
			to: '/$workspaceId/chats/new',
			params: { workspaceId },
			search: {
				agentId: viewBuilder.id,
				agentName: viewBuilder.name,
				objectId: loopId,
				objectTitle: loop?.name ?? undefined,
				objectType: 'loop',
				text: `New view for ${loop?.name ?? 'this flow'}: `,
			},
		})
	}, [viewBuilder, navigate, workspaceId, loopId, loop?.name])

	// "Message" on the Decisions card: bring the flow's own composer into reach and focus it.
	const handleMessageDriver = useCallback(() => {
		composerRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
		const field = composerRef.current?.querySelector<HTMLElement>(
			'textarea, [contenteditable="true"], input',
		)
		field?.focus()
	}, [])

	// The stage the flow works in. Pausing stays under the "..." menu, so a stage never hides it.
	const handleChangeStage = useCallback(
		async (status: LoopStatus) => {
			try {
				await updateObject.mutateAsync({ id: loopId, data: { status } })
			} catch {
				toast.error('Could not change the stage')
			}
		},
		[loopId, updateObject],
	)

	// Tags other flows already use, A to Z, so a new tag can be picked instead of retyped.
	const allLoops = useLoops(workspaceId)
	const tagSuggestions = useMemo(() => {
		const seen = new Map<string, string>()
		for (const l of allLoops.data ?? [])
			for (const t of l.tags) if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
		return [...seen.values()].sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
		)
	}, [allLoops.data])

	const handleUpdateTags = useCallback(
		async (tags: string[]) => {
			// Show the tag at once: the page reads it from the flows list, which only
			// refreshes after the save and the reload that follows it.
			const key = queryKeys.loops.all(workspaceId)
			await queryClient.cancelQueries({ queryKey: key })
			const previous = queryClient.getQueryData<{ loops: LoopSummary[] }>(key)
			if (previous) {
				queryClient.setQueryData(key, {
					...previous,
					loops: previous.loops.map((l) => (l.id === loopId ? { ...l, tags } : l)),
				})
			}
			try {
				await updateObject.mutateAsync({ id: loopId, data: { metadata: { tags } } })
			} catch {
				if (previous) queryClient.setQueryData(key, previous)
				toast.error('Could not save your changes')
			}
		},
		[loopId, updateObject, queryClient, workspaceId],
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
	const decideJumpHref = '#loop-decisions'

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
	// Groups follow the workspace's status order; inside a group, A to Z by title.
	const statusRank = new Map<string, number>()
	for (const chain of Object.values(statusChains ?? {})) {
		for (const status of chain) if (!statusRank.has(status)) statusRank.set(status, statusRank.size)
	}
	const sortedChildren = [...(children ?? [])].sort(
		(a, b) =>
			(statusRank.get(a.status) ?? Number.MAX_SAFE_INTEGER) -
				(statusRank.get(b.status) ?? Number.MAX_SAFE_INTEGER) ||
			(a.title ?? '').localeCompare(b.title ?? '', undefined, {
				sensitivity: 'base',
				numeric: true,
			}),
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
					<DropdownMenu>
						<ViewerTooltip>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									data-testid="loop-pill"
									disabled={!canWrite || !object}
									aria-label={`Stage: ${LOOP_PILL_STYLES[loop.status].label}`}
									className="inline-flex h-9 items-center gap-2 rounded-full border border-border px-3.5 text-[13.5px] font-semibold text-foreground disabled:cursor-default"
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
									{canWrite && object && (
										<ChevronDown size={11} aria-hidden="true" className="text-muted-foreground" />
									)}
								</button>
							</DropdownMenuTrigger>
						</ViewerTooltip>
						<DropdownMenuContent align="start">
							{LOOP_STAGES.map((stage) => (
								<DropdownMenuItem
									key={stage}
									onClick={() => handleChangeStage(stage)}
									className="gap-2"
								>
									<span>{LOOP_PILL_STYLES[stage].label}</span>
									{loop.status === stage && (
										<Check size={13} className="ml-auto" aria-hidden="true" />
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					{driver && (
						<span
							data-testid="loop-driver"
							className="inline-flex h-9 items-center gap-2 rounded-full border border-border px-3.5 text-[13.5px]"
						>
							<ActorAvatar id={driver.id} name={driver.name} type={driver.type} />
							<span className="font-semibold text-foreground">{driver.name}</span>
						</span>
					)}
					{needsYouRows.length > 0 && (
						<span
							data-testid="loop-decisions-chip"
							className="inline-flex h-9 items-center rounded-full border border-border px-3.5 text-[13.5px] font-semibold text-foreground"
						>
							{needsYouRows.length === 1
								? '1 decision needed'
								: `${needsYouRows.length} decisions needed`}
						</span>
					)}
					<LoopTags
						tags={loop.tags}
						canWrite={canWrite && !!object}
						onChange={handleUpdateTags}
						suggestions={tagSuggestions}
					/>
				</div>

				<div className="mt-6">
					<LoopDetailTabs
						tabs={[
							// Custom views come first, the briefing ahead of the rest, with a hairline
							// between them and the built-in tabs.
							...(hasBriefings
								? [{ value: 'briefings', label: pinnedBriefing?.name ?? 'Briefings' }]
								: []),
							...viewTabs.map((v) => ({ value: v.value, label: v.name })),
							{
								value: 'overview',
								label: 'Overview',
								count: needsYouRows.length,
								startsGroup: hasBriefings || viewTabs.length > 0,
							},
							{ value: 'items', label: 'Items', count: childIds.length },
							{ value: 'activity', label: 'Activity' },
							{ value: 'setup', label: 'Setup' },
						]}
						value={activeTab}
						onChange={setTab}
						onAdd={canWrite && object && viewBuilder ? handleNewView : undefined}
						addLabel="Ask for a new view"
					/>
				</div>

				{activeTab === 'overview' && (
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

						<LoopDecisions
							workspaceId={workspaceId}
							rows={needsYouRows.map(({ item, ask }) => ({
								item,
								ask: {
									title: ask.title,
									createdAt: ask.createdAt,
									sourceActorId: ask.sourceActorId,
								},
							}))}
							actors={actors}
							messageLabel={driver?.name}
							onMessage={handleMessageDriver}
						/>
					</div>
				)}

				{activeView && (
					<div role="tabpanel" className="mt-8 min-w-0">
						<LoopViewTab
							key={activeView.value}
							workspaceId={workspaceId}
							loopId={loopId}
							fileId={activeView.fileId}
							name={activeView.name}
							onRename={
								canWrite && object ? (name) => handleRenameView(activeView.fileId, name) : undefined
							}
							onRemove={
								canWrite && object ? () => void handleRemoveView(activeView.fileId) : undefined
							}
							busy={updateObject.isPending}
						/>
					</div>
				)}

				{activeTab === 'briefings' && hasBriefings && (
					<div role="tabpanel" className="mt-8 min-w-0">
						<LoopBriefingTab workspaceId={workspaceId} pages={briefingPages} />
					</div>
				)}

				{activeTab === 'items' && (
					<div role="tabpanel" className="mt-4 flex min-w-0 flex-col">
						{childrenFailed ? (
							<LoopBlockError
								message={`Couldn't load the items of this flow. ${SLOW_LOAD_MESSAGE}`}
								onRetry={() => childrenQuery.refetch?.()}
							/>
						) : sortedChildren.length === 0 ? (
							<EmptyState
								title="No items in this flow yet"
								description="Items show up here once the flow starts working on them."
							/>
						) : (
							<ListView
								data={sortedChildren}
								workspaceId={workspaceId}
								actors={actors}
								grouping={ITEMS_GROUPING}
								rowSelection={itemSelection}
								onRowSelectionChange={setItemSelection}
								columnVisibility={ITEMS_COLUMNS}
								expanded={itemGroupsOpen}
								onExpandedChange={setItemGroupsOpen}
							/>
						)}
					</div>
				)}

				{activeTab === 'activity' && object && (
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

				{activeTab === 'setup' && (
					<div role="tabpanel" className="mt-8 flex flex-col gap-8">
						<LoopStats
							loop={loop}
							cyclesRunning={cyclesRunning}
							asksWaiting={asksWaiting}
							nextFire={nextFire}
						/>
						<SetupBlock label="Starts when" text={loop.entryCondition} />
						<SetupBlock label="Ends when" text={loop.closeCondition} />
						<div>
							{flowFailed ? (
								<LoopBlockError
									message={`Couldn't load how this flow runs. ${SLOW_LOAD_MESSAGE}`}
									onRetry={() => {
										for (const [failed, query] of [
											[triggersFailed, triggersQuery],
											[actorsFailed, actorsQuery],
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
					</div>
				)}

				<LoopUtteranceInput
					ref={composerRef}
					loop={loop}
					placeholder={
						driver ? `Message ${driver.name}, who drives ${loop.name ?? 'this flow'}` : undefined
					}
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
