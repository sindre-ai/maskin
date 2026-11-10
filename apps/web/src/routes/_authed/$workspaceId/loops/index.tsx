import { usePlanPercentEnabled } from '@/components/billing/plan-percent-context'
import { PageHeader } from '@/components/layout/page-header'
import {
	type FailedAgent,
	buildFlowsBrief,
	failedAgentForLoop,
} from '@/components/loops/loop-brief'
import { LoopCard } from '@/components/loops/loop-card'
import { isLiveLoopPill } from '@/components/loops/loop-pill'
import { LoopRow } from '@/components/loops/loop-row'
import type { DisplayFilterSectionModel } from '@/components/objects/data-table/display-filter-section'
import { DisplayPanel } from '@/components/objects/data-table/display-panel'
import { BuyCreditsDialog } from '@/components/settings/buy-credits-dialog'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { PageSearchInput } from '@/components/shared/page-search-input'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useActors } from '@/hooks/use-actors'
import { useBillingUsage } from '@/hooks/use-billing'
import { useCanWrite } from '@/hooks/use-can-write'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useLoops } from '@/hooks/use-loops'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlanUsage } from '@/hooks/use-plan-usage'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import { useUpdateTrigger } from '@/hooks/use-triggers'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { getActiveAgentSessions } from '@/lib/agent-status'
import type { DisplaySettingsBody, LoopSummary } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronRight, LayoutList, RefreshCw, Rows3 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

// Display settings are keyed by object type; `loop` is a real object type, so
// the loops list persists its ordering in the same store Objects uses.
const LOOP_SETTINGS_KEY = 'loop'
const DEFAULT_SORT = 'updatedAt'
const DEFAULT_ORDER: 'asc' | 'desc' = 'desc'

const LOOP_ORDER_COLUMNS = [
	{ id: 'updatedAt', label: 'Last activity', canHide: false },
	{ id: 'name', label: 'Name', canHide: false },
	{ id: 'inProgressCount', label: 'In progress', canHide: false },
]

type FlowsView = 'cards' | 'list'
const VIEW_STORAGE_KEY = 'maskin-flows-view'

/** The saved view choice; null when the person never chose one (Cards then). */
function readSavedView(): FlowsView | null {
	try {
		const saved = window.localStorage.getItem(VIEW_STORAGE_KEY)
		return saved === 'cards' || saved === 'list' ? saved : null
	} catch {
		return null
	}
}

type LoopTab = 'all' | 'to-decide' | 'running'

const NO_AREA = '__none'
const NO_AREA_LABEL = 'No team'
const TAB_LABEL: Record<Exclude<LoopTab, 'all'>, string> = {
	'to-decide': 'Needs you',
	running: 'Running',
}

/** Every typed word must appear in the flow's name, description or tags. */
function matchesQuery(loop: LoopSummary, words: string[]): boolean {
	if (words.length === 0) return true
	const haystack = [loop.name ?? '', loop.content ?? '', ...loop.tags].join(' ').toLowerCase()
	return words.every((word) => haystack.includes(word))
}

function matchesTab(loop: LoopSummary, tab: LoopTab): boolean {
	if (tab === 'to-decide') return loop.pill === 'waiting_on_you'
	if (tab === 'running') return isLiveLoopPill(loop.pill)
	return true
}

function compareLoops(a: LoopSummary, b: LoopSummary, sort: string): number {
	if (sort === 'name') return (a.name ?? '').localeCompare(b.name ?? '')
	if (sort === 'inProgressCount') return a.inProgressCount - b.inProgressCount
	return new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()
}

export const Route = createFileRoute('/_authed/$workspaceId/loops/')({
	component: LoopsRoute,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function LoopsRoute() {
	const isMobile = useIsMobile()
	useDocumentTitle('Flows')
	const { workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const {
		data: loops,
		isLoading: loopsLoading,
		isError: isLoopsError,
		error: loopsError,
		refetch: refetchLoops,
	} = useLoops(workspaceId)
	const { data: triggers } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const [createPickerOpen, setCreatePickerOpen] = useState(false)
	const [buyCreditsOpen, setBuyCreditsOpen] = useState(false)
	// Collapsed by default: the automations are background plumbing, not what the page is for.
	const [automationsOpen, setAutomationsOpen] = useState(false)
	const [tab, setTab] = useState<LoopTab>('all')
	const [areaFilter, setAreaFilter] = useState<string | undefined>(undefined)
	const [query, setQuery] = useState('')
	const [savedView, setSavedView] = useState<FlowsView | null>(readSavedView)
	const view: FlowsView = savedView ?? 'cards'
	const chooseView = useCallback((next: FlowsView | null) => {
		setSavedView(next)
		try {
			if (next) window.localStorage.setItem(VIEW_STORAGE_KEY, next)
			else window.localStorage.removeItem(VIEW_STORAGE_KEY)
		} catch {
			// Storage unavailable: the choice holds for this visit only.
		}
	}, [])

	const { data: billingUsage } = useBillingUsage(workspaceId)
	// With the percent display on there is no top-up: the pill says the plan is
	// used up, follows the 100% rule, and opens Billing to pick a plan.
	const planPercentOn = usePlanPercentEnabled()
	const { state: planUsage } = usePlanUsage(workspaceId)
	const navigate = useNavigate()
	const showNoCreditsPill = planPercentOn
		? planUsage?.paused === true
		: typeof billingUsage?.credit_balance_cents === 'number'
			? billingUsage.credit_balance_cents <= 0
			: false

	const settingsQuery = useUserDisplaySettings(workspaceId, LOOP_SETTINGS_KEY)
	const upsertSettings = useUpdateUserDisplaySettings(workspaceId)
	const persistedSettings = settingsQuery.data?.settings
	const sort = persistedSettings?.sort ?? DEFAULT_SORT
	const order = persistedSettings?.order ?? DEFAULT_ORDER

	const writeSettings = useCallback(
		(patch: DisplaySettingsBody | null) => {
			upsertSettings.mutate({
				objectType: LOOP_SETTINGS_KEY,
				settings: patch === null ? {} : { ...(persistedSettings ?? {}), ...patch },
			})
		},
		[upsertSettings, persistedSettings],
	)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	const sortedLoops = useMemo(() => {
		const list = [...(loops ?? [])]
		list.sort((a, b) => (order === 'asc' ? 1 : -1) * compareLoops(a, b, sort))
		return list
	}, [loops, sort, order])

	// `LoopSummary.triggerIds` is the canonical membership field — a trigger is
	// standalone iff no loop names it. (The previous target-actor heuristic hid
	// any standalone trigger that happened to share an agent with a loop.)
	const standaloneTriggers = useMemo(() => {
		if (!triggers) return []
		const tied = new Set((loops ?? []).flatMap((l) => l.triggerIds))
		return triggers.filter((t) => !tied.has(t.id))
	}, [loops, triggers])

	// Agents with a live session right now — colours the loop rows' busy line.
	const workingAgentIds = useMemo(
		() => new Set(getActiveAgentSessions(sessions ?? []).map((s) => s.actorId)),
		[sessions],
	)

	// A flow's newest failed agent, from the sessions already loaded for this page.
	const failedByLoopId = useMemo(() => {
		const map = new Map<string, FailedAgent>()
		for (const loop of loops ?? []) {
			const failed = failedAgentForLoop(loop, sessions, actors)
			if (failed) map.set(loop.id, failed)
		}
		return map
	}, [loops, sessions, actors])
	const brief = useMemo(() => buildFlowsBrief(loops ?? [], failedByLoopId), [loops, failedByLoopId])

	const hasLoops = sortedLoops.length > 0
	const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])
	const visibleLoops = useMemo(
		() =>
			sortedLoops.filter(
				(loop) =>
					matchesTab(loop, tab) &&
					(areaFilter === undefined || (loop.tags[0] ?? NO_AREA) === areaFilter) &&
					matchesQuery(loop, words),
			),
		[sortedLoops, tab, areaFilter, words],
	)

	// The Display menu's Show and Area rows. Counts come off the unfiltered list
	// so a row's number stays put while it is the active filter.
	const filterSections = useMemo<DisplayFilterSectionModel[]>(() => {
		const areaCounts = new Map<string, number>()
		for (const loop of sortedLoops) {
			const key = loop.tags[0] ?? NO_AREA
			areaCounts.set(key, (areaCounts.get(key) ?? 0) + 1)
		}
		const areas = [...areaCounts.keys()].sort((a, b) => {
			if (a === NO_AREA || b === NO_AREA) return a === NO_AREA ? 1 : -1
			return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
		})
		const areaLabel = (key: string) => (key === NO_AREA ? NO_AREA_LABEL : key)
		const sections: DisplayFilterSectionModel[] = [
			{
				id: 'show',
				label: 'Show',
				summary: tab === 'all' ? 'All' : TAB_LABEL[tab],
				pinnable: false,
				options: (['to-decide', 'running'] as const).map((id) => ({
					id,
					label: TAB_LABEL[id],
					count: sortedLoops.filter((l) => matchesTab(l, id)).length,
					active: tab === id,
					onToggle: () => setTab(tab === id ? 'all' : id),
				})),
			},
		]
		// Areas only exist once some flow carries a tag.
		if (areas.some((key) => key !== NO_AREA)) {
			sections.push({
				id: 'area',
				label: 'Area',
				summary: areaFilter === undefined ? 'All' : areaLabel(areaFilter),
				pinnable: false,
				options: areas.map((key) => ({
					id: key,
					label: areaLabel(key),
					count: areaCounts.get(key),
					active: areaFilter === key,
					onToggle: () => setAreaFilter(areaFilter === key ? undefined : key),
				})),
			})
		}
		return sections
	}, [sortedLoops, tab, areaFilter])
	const activeFilterCount = (tab !== 'all' ? 1 : 0) + (areaFilter !== undefined ? 1 : 0)
	// Sections follow the loops' first free-form tag (`metadata.tags`: team,
	// business unit, ...), A to Z, untagged last. With no tags anywhere the list
	// stays one flat run with no headers.
	const loopGroups = useMemo(() => {
		const byTag = new Map<string, LoopSummary[]>()
		for (const loop of visibleLoops) {
			const key = loop.tags[0] ?? ''
			byTag.set(key, [...(byTag.get(key) ?? []), loop])
		}
		return [...byTag.entries()]
			.sort(([a], [b]) => {
				if (!a || !b) return a ? -1 : b ? 1 : 0
				return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
			})
			.map(([label, items]) => ({ label, items }))
	}, [visibleLoops])
	const hasTaggedLoops = loopGroups.some((g) => g.label)

	return (
		<div>
			<PageHeader
				title="Flows"
				actions={
					<>
						<PageSearchInput value={query} onChange={setQuery} label="Search flows" />
						<DisplayPanel
							viewChoices={[
								{ id: 'cards', label: 'Cards', icon: <LayoutList size={15} aria-hidden="true" /> },
								{ id: 'list', label: 'List', icon: <Rows3 size={15} aria-hidden="true" /> },
							]}
							viewChoice={view}
							onViewChoiceChange={(id) => chooseView(id === 'list' ? 'list' : 'cards')}
							filterSections={filterSections}
							activeFilterCount={activeFilterCount}
							filtersLabel="Filters"
							resetFiltersLabel="Reset filters"
							resetLabel="Reset display"
							onResetFilters={() => {
								setTab('all')
								setAreaFilter(undefined)
							}}
							columns={LOOP_ORDER_COLUMNS}
							sort={sort}
							order={order}
							onSortChange={(value) => writeSettings({ sort: value })}
							onOrderChange={(value) => writeSettings({ order: value })}
							onResetToDefault={() => {
								writeSettings(null)
								chooseView(null)
								setTab('all')
								setAreaFilter(undefined)
							}}
						/>
					</>
				}
			/>
			{hasLoops && !loopsLoading && (
				<p
					data-testid="flows-brief"
					className="mb-6 max-w-[64ch] text-base md:-mt-1.5 leading-[1.55] text-muted-foreground"
				>
					<strong className="font-bold text-foreground">{brief.lead}</strong>
				</p>
			)}
			{loopsLoading ? (
				<ListSkeleton />
			) : isLoopsError && !loops ? (
				// A failed fetch must not fall through to "No loops running here
				// yet" — that would claim the workspace is empty when it isn't.
				<QueryStateError
					title="Couldn't load flows"
					error={loopsError ?? new Error('Something went wrong.')}
					onRetry={() => refetchLoops()}
				/>
			) : (
				<div className="space-y-10">
					<section className="flex flex-col">
						{hasLoops && visibleLoops.length === 0 ? (
							<p className="py-9 text-center text-[12.5px] text-muted-foreground">
								No flows match.
							</p>
						) : hasLoops ? (
							loopGroups.map((group) => (
								<div key={group.label || 'untagged'} className="flex flex-col">
									{hasTaggedLoops && (
										<h2 className="px-1 pt-3.5 pb-3 text-[15px] font-semibold text-foreground">
											{group.label || 'No team'}
										</h2>
									)}
									{view === 'cards' ? (
										<div className="grid grid-cols-1 gap-3 pb-6.5 md:grid-cols-2">
											{group.items.map((loop) => {
												const failed = failedByLoopId.get(loop.id) ?? null
												return (
													<LoopCard
														key={loop.id}
														loop={loop}
														failed={failed}
														needsYou={loop.pill === 'waiting_on_you' || failed !== null}
													/>
												)
											})}
										</div>
									) : (
										group.items.map((loop) => (
											<LoopRow
												key={loop.id}
												loop={loop}
												actors={actors}
												busyAgentCount={
													loop.agentIds.filter((id) => workingAgentIds.has(id)).length
												}
												showNoCreditsPill={showNoCreditsPill}
												onNoCreditsClick={() =>
													planPercentOn
														? navigate({
																to: '/$workspaceId/settings/billing',
																params: { workspaceId },
															})
														: setBuyCreditsOpen(true)
												}
											/>
										))
									)}
								</div>
							))
						) : (
							<EmptyState
								icon={<RefreshCw size={22} aria-hidden="true" />}
								title="No flows yet"
								description="Ask the Chief of Staff to set one up."
								action={
									<div className="flex items-center gap-2">
										{canWrite ? (
											<Button size="sm" asChild>
												<Link to="/$workspaceId/loops/new" params={{ workspaceId }}>
													Start a flow
												</Link>
											</Button>
										) : (
											<ViewerTooltip>
												<Button size="sm" disabled>
													Start a flow
												</Button>
											</ViewerTooltip>
										)}
										<Button size="sm" variant="outline" asChild>
											<Link to="/$workspaceId/marketplace" params={{ workspaceId }}>
												Browse the Marketplace
											</Link>
										</Button>
									</div>
								}
							/>
						)}
					</section>

					<Collapsible asChild open={automationsOpen} onOpenChange={setAutomationsOpen}>
						<section>
							<header className="flex items-center gap-2.5 px-1">
								<h2 className="text-sm font-bold text-foreground">
									<CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
										<ChevronRight
											aria-hidden="true"
											className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
										/>
										Not tied to a flow
									</CollapsibleTrigger>
								</h2>
								<p className="text-[11px] text-muted-foreground">
									workspace-wide automations that run on their own
								</p>
								<span aria-hidden="true" className="h-px flex-1 bg-border" />
							</header>
							<CollapsibleContent>
								{standaloneTriggers.length === 0 ? (
									<EmptyState
										title="No workspace-wide automations yet"
										description="Automations that run on their own — outside any flow — show up here."
									/>
								) : (
									<div className="flex flex-col pt-3">
										{standaloneTriggers.map((trigger) => {
											const agent = actors?.find((a) => a.id === trigger.targetActorId)
											return (
												<TriggerRow
													key={trigger.id}
													trigger={trigger}
													workspaceId={workspaceId}
													agentId={agent?.id}
													agentType={agent?.type}
													agentName={agent?.name ?? 'Unknown'}
													isToggling={updateTrigger.isPending}
													onToggleEnabled={(next) => {
														if (!canWrite) return
														updateTrigger.mutate({ id: trigger.id, data: { enabled: next } })
													}}
													v4Polish
												/>
											)
										})}
									</div>
								)}
							</CollapsibleContent>
						</section>
					</Collapsible>
				</div>
			)}
			<CreatePicker open={createPickerOpen} onOpenChange={setCreatePickerOpen} defaultType="loop" />
			{billingUsage?.credit_topup_available && (
				<BuyCreditsDialog
					open={buyCreditsOpen}
					onOpenChange={setBuyCreditsOpen}
					workspaceId={workspaceId}
				/>
			)}
		</div>
	)
}
