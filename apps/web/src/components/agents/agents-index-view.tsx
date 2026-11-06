import { AgentCallButton } from '@/components/agents/agent-call-button'
import {
	AgentStatusPill,
	type PortraitStatus,
	agentAvatarStatus,
	agentTileClass,
	describeFocus,
	getPortraitStatus,
	portraitStatusToFilter,
} from '@/components/agents/agent-portrait-card'
import { PageHeader } from '@/components/layout/page-header'
import type { DisplayFilterSectionModel } from '@/components/objects/data-table/display-filter-section'
import type { DisplayPanelColumn } from '@/components/objects/data-table/display-panel'
import { DisplayPanel } from '@/components/objects/data-table/display-panel'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { FilterChip } from '@/components/shared/filter-chip'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { PageSearchInput } from '@/components/shared/page-search-input'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import {
	deriveAgentKind,
	deriveAgentStatus,
	deriveAgentStatusFromStats,
	getLatestSession,
	groupSessionsByAgent,
	statsToCounts,
	summarizeAgentSessions,
} from '@/lib/agent-status'
import { NO_TEAM, buildAgentFilterPills, buildTeamChips } from '@/lib/agents-index-filters'
import type { ActorListItem, DisplaySettingsBody, LoopSummary, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import type { SessionStatsRow } from '@maskin/shared'
import { Link, useNavigate } from '@tanstack/react-router'
import { Ellipsis } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

const AGENTS_DISPLAY_KEY = 'agents'
const DEFAULT_GROUP_BY = 'team'
const MULTIPLE_STATUSES = '__multiple__'

export const AGENT_STATUSES = ['working', 'idle', 'failed'] as const
type StatusBucket = (typeof AGENT_STATUSES)[number]

const COLUMNS: DisplayPanelColumn[] = [
	{ id: 'name', label: 'Name', canHide: false },
	{ id: 'kind', label: 'Kind', canHide: false },
	{ id: 'team', label: 'Team', canHide: true },
	{ id: 'activity', label: 'Latest', canHide: true },
	{ id: 'sessions', label: 'Sessions', canHide: true },
	{ id: 'status', label: 'Status', canHide: false },
]

export const STATUS_GROUP_META: Record<StatusBucket, { label: string; note: string }> = {
	working: { label: 'Working', note: 'Agents with a session in progress' },
	idle: { label: 'Idle', note: 'Standing by for their next run' },
	failed: { label: 'Failed', note: 'Last run errored' },
}

/** Display name of a status bucket; an unknown bucket keeps its key. */
function statusLabel(bucket: string): string {
	return STATUS_GROUP_META[bucket as StatusBucket]?.label ?? bucket
}

const STATUS_RANK: Record<PortraitStatus, number> = {
	running: 0,
	paused: 1,
	idle: 2,
	failed: 3,
}

interface AgentRow {
	agent: ActorListItem
	portrait: PortraitStatus
	latestSession?: SessionResponse
	sessionCount: number
	activeCount: number
	totalCostUsd: number
	last30dCostUsd: number
	/** The first flow (A to Z) this agent works in, or the no-team label. */
	team: string
}

/** The slice of a flow the Team column needs. */
export type AgentsLoop = Pick<LoopSummary, 'name' | 'agentIds'>

/** An agent's team is the first flow it appears in, alphabetically. */
function buildTeamByAgent(loops: AgentsLoop[] | undefined): Map<string, string> {
	const named = (loops ?? [])
		.filter((l) => l.name?.trim())
		.map((l) => ({ name: (l.name as string).trim(), agentIds: l.agentIds }))
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
	const teams = new Map<string, string>()
	for (const loop of named) {
		for (const id of loop.agentIds) if (!teams.has(id)) teams.set(id, loop.name)
	}
	return teams
}

export function AgentsIndexView({
	workspaceId,
	agents,
	sessions,
	stats,
	loops,
	query,
	onQueryChange,
}: {
	workspaceId: string
	agents: ActorListItem[]
	/** The 100 newest sessions: the source of live status. */
	sessions: SessionResponse[]
	/** Per-agent counts and cost over the whole history; the recent list stands in until it loads. */
	stats?: SessionStatsRow[]
	/** Flows, for the Team column and group-by Team. */
	loops?: AgentsLoop[]
	/** Search text; the input itself sits beside the page title (see PageSearchInput). */
	query: string
	onQueryChange: (value: string) => void
}) {
	const [sort, setSort] = useState('name')
	const [order, setOrder] = useState<'asc' | 'desc'>('asc')
	// Below md the title row has no room for words: Display is its icon.
	const isMobile = useIsMobile()
	const displaySettingsQuery = useUserDisplaySettings(workspaceId, AGENTS_DISPLAY_KEY)
	// Teams are the default grouping, but only while nothing is saved: a saved
	// choice (including a saved Status) always wins. A cached read seeds it so a
	// returning visit never flashes the other grouping before hydration.
	const savedGroupBy = displaySettingsQuery.data?.settings?.groupBy
	const [groupBy, setGroupBy] = useState<string | undefined>(
		savedGroupBy !== undefined ? (savedGroupBy ?? undefined) : DEFAULT_GROUP_BY,
	)
	const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({})
	const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)
	// One team at a time. Not persisted: the display-settings schema has no team key.
	const [teamFilter, setTeamFilter] = useState<string | undefined>(undefined)

	// Per-actor display settings — same hydration-gated, debounced write-through
	// rail the Objects page uses (see objects/index.tsx), keyed by the literal
	// `agents` object_type so group/order/visibility choices survive navigation.
	const updateDisplaySettings = useUpdateUserDisplaySettings(workspaceId)
	const updateMutateRef = useRef(updateDisplaySettings.mutate)
	updateMutateRef.current = updateDisplaySettings.mutate
	const hydratedRef = useRef(false)

	useEffect(() => {
		if (hydratedRef.current) return
		if (!displaySettingsQuery.isSuccess) return
		hydratedRef.current = true
		const s = displaySettingsQuery.data?.settings
		if (!s) return
		if (s.sort) setSort(s.sort)
		if (s.order) setOrder(s.order)
		if (s.groupBy !== undefined) setGroupBy(s.groupBy ?? undefined)
		if (s.columnVisibility) setColumnVisibility(s.columnVisibility)
		if (s.filters?.status) setStatusFilter(s.filters.status)
	}, [displaySettingsQuery.isSuccess, displaySettingsQuery.data])

	useEffect(() => {
		if (!hydratedRef.current) return
		const settings: DisplaySettingsBody = {
			sort,
			order,
			groupBy: groupBy ?? null,
			columnVisibility,
		}
		if (statusFilter) settings.filters = { status: statusFilter }
		const handle = setTimeout(() => {
			updateMutateRef.current({ objectType: AGENTS_DISPLAY_KEY, settings })
		}, 500)
		return () => clearTimeout(handle)
	}, [sort, order, groupBy, columnVisibility, statusFilter])

	const sessionsByAgent = useMemo(() => groupSessionsByAgent(sessions), [sessions])

	const statsByAgent = useMemo(() => new Map((stats ?? []).map((s) => [s.actor_id, s])), [stats])

	const teamByAgent = useMemo(() => buildTeamByAgent(loops), [loops])

	const rows = useMemo<AgentRow[]>(
		() =>
			agents.map((agent) => {
				const agentStats = statsByAgent.get(agent.id)
				// Live status comes from the recent list; an agent with nothing in it falls back to the
				// stats (active run, or a failed latest run) so older history still shows.
				const sessionStatus = sessionsByAgent.has(agent.id)
					? deriveAgentStatus(agent.id, sessionsByAgent)
					: deriveAgentStatusFromStats(agentStats)
				const counts = stats
					? statsToCounts(agentStats)
					: summarizeAgentSessions(sessionsByAgent.get(agent.id))
				return {
					agent,
					portrait: getPortraitStatus(agent, sessionStatus),
					latestSession: getLatestSession(agent.id, sessionsByAgent),
					sessionCount: counts.total,
					activeCount: counts.active,
					totalCostUsd: counts.totalCostUsd,
					last30dCostUsd: counts.last30dCostUsd,
					team: teamByAgent.get(agent.id) ?? NO_TEAM,
				}
			}),
		[agents, sessionsByAgent, statsByAgent, stats, teamByAgent],
	)

	const activeStatuses = useMemo(
		() => (statusFilter ? statusFilter.split(',').filter(Boolean) : []),
		[statusFilter],
	)

	// `voice` was a filter chip until every agent became callable; a persisted
	// or bookmarked `voice` must not empty the list. Other unknown values still
	// fail closed (empty state), by design.
	const statusOnlyFilters = useMemo(
		() => activeStatuses.filter((s) => s !== 'voice'),
		[activeStatuses],
	)

	const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query])

	const visibleRows = useMemo(
		() =>
			rows.filter((row) => {
				const bucket = portraitStatusToFilter(row.portrait)
				const statusMatches = statusOnlyFilters.length === 0 || statusOnlyFilters.includes(bucket)
				if (!statusMatches) return false
				if (teamFilter !== undefined && row.team !== teamFilter) return false
				if (words.length === 0) return true
				// Every typed word must match the name, outcome, kind or team.
				const haystack = [
					row.agent.name,
					row.agent.description ?? '',
					row.agent.role ?? '',
					row.team,
				]
					.join(' ')
					.toLowerCase()
				return words.every((word) => haystack.includes(word))
			}),
		[rows, statusOnlyFilters, teamFilter, words],
	)

	const sortedRows = useMemo(() => {
		const arr = [...visibleRows]
		const dir = order === 'asc' ? 1 : -1
		const byName = (a: AgentRow, b: AgentRow) => a.agent.name.localeCompare(b.agent.name)
		switch (sort) {
			case 'kind':
				arr.sort((a, b) => {
					const byKind = deriveAgentKind(a.agent).localeCompare(deriveAgentKind(b.agent))
					return dir * (byKind || byName(a, b))
				})
				break
			case 'team':
				arr.sort((a, b) => {
					const byTeam = a.team.localeCompare(b.team)
					return dir * (byTeam || byName(a, b))
				})
				break
			case 'status':
				arr.sort((a, b) => {
					const byStatus = STATUS_RANK[a.portrait] - STATUS_RANK[b.portrait]
					return dir * (byStatus || byName(a, b))
				})
				break
			case 'sessions':
				arr.sort((a, b) => {
					const byCount = a.sessionCount - b.sessionCount
					return dir * (byCount || byName(a, b))
				})
				break
			case 'cost':
				arr.sort((a, b) => {
					const byCost = a.totalCostUsd - b.totalCostUsd
					return dir * (byCost || byName(a, b))
				})
				break
			default:
				arr.sort((a, b) => dir * byName(a, b))
		}
		return arr
	}, [visibleRows, sort, order])

	const groups = useMemo(() => {
		if (groupBy === 'status') {
			// Filter the active statuses against the known buckets instead of
			// casting: a stale persisted filter can't crash the group render
			// via an undefined STATUS_GROUP_META entry.
			const buckets: StatusBucket[] = [...AGENT_STATUSES].filter((b) =>
				statusOnlyFilters.length === 0 ? true : statusOnlyFilters.includes(b),
			)
			return buckets.map((bucket) => {
				const meta = STATUS_GROUP_META[bucket]
				return {
					id: bucket,
					label: meta.label,
					note: meta.note,
					rows: sortedRows.filter((row) => portraitStatusToFilter(row.portrait) === bucket),
				}
			})
		}
		if (groupBy === 'kind') {
			const byKind = new Map<string, AgentRow[]>()
			for (const row of sortedRows) {
				const kind = deriveAgentKind(row.agent)
				const list = byKind.get(kind)
				if (list) list.push(row)
				else byKind.set(kind, [row])
			}
			return Array.from(byKind.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([kind, kindRows]) => ({
					id: kind,
					label: kind,
					note: undefined,
					rows: kindRows,
				}))
		}
		if (groupBy === 'team') {
			const byTeam = new Map<string, AgentRow[]>()
			for (const row of sortedRows) {
				const list = byTeam.get(row.team)
				if (list) list.push(row)
				else byTeam.set(row.team, [row])
			}
			// A to Z, with the catch-all group last.
			return Array.from(byTeam.entries())
				.sort(([a], [b]) => {
					if (a === NO_TEAM) return b === NO_TEAM ? 0 : 1
					if (b === NO_TEAM) return -1
					return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
				})
				.map(([team, teamRows]) => ({
					id: team,
					label: team,
					note: undefined,
					rows: teamRows,
				}))
		}
		return [{ id: 'all', label: undefined, note: undefined, rows: sortedRows }]
	}, [groupBy, statusOnlyFilters, sortedRows])

	const showTeam = columnVisibility.team !== false
	const showActivity = columnVisibility.activity !== false
	const showSessions = columnVisibility.sessions !== false

	// Counts come off the pre-filter `rows` so a chip's number stays stable while
	// that chip is the active filter (mockup 2290–2293).
	const statusCounts = useMemo(() => {
		const counts: Record<StatusBucket, number> = { working: 0, idle: 0, failed: 0 }
		for (const row of rows) counts[portraitStatusToFilter(row.portrait)]++
		return counts
	}, [rows])

	// One chip per team that has agents, counted before any filter so a chip's
	// number stays put while it is the active one.
	const teamChips = useMemo(() => buildTeamChips(rows.map((r) => r.team)), [rows])

	// The Display menu's Status and Team rows (mockup 2304). Same buckets and the
	// same pre-filter counts the chip strips draw, built once so they can't
	// disagree. Not pinnable — the chip strips above already *are* the pinned rows.
	const filterSections = useMemo<DisplayFilterSectionModel[]>(() => {
		const sections: DisplayFilterSectionModel[] = [
			{
				id: 'status',
				label: 'Status',
				summary: activeStatuses.length > 0 ? activeStatuses.map(statusLabel).join(', ') : 'All',
				pinnable: false,
				options: AGENT_STATUSES.map((bucket) => ({
					id: bucket,
					label: STATUS_GROUP_META[bucket].label,
					count: statusCounts[bucket],
					active: activeStatuses.includes(bucket),
					onToggle: () => {
						const next = activeStatuses.includes(bucket)
							? activeStatuses.filter((s) => s !== bucket)
							: [...activeStatuses, bucket]
						setStatusFilter(next.length > 0 ? next.join(',') : undefined)
					},
				})),
			},
		]
		if (teamChips.length > 0) {
			sections.push({
				id: 'team',
				label: 'Team',
				summary: teamFilter ?? 'All',
				pinnable: false,
				options: teamChips.map(({ team, count }) => ({
					id: team,
					label: team,
					count,
					active: teamFilter === team,
					onToggle: () => setTeamFilter(teamFilter === team ? undefined : team),
				})),
			})
		}
		return sections
	}, [activeStatuses, statusCounts, teamChips, teamFilter])

	// The Display menu's Status filter is multi-select, so the chip strip reads the active *set*:
	// All is pressed only with no status chosen, a chip only when it is the one status chosen,
	// and with several chosen no chip is pressed (a click on one then narrows to just that one).
	const statusChipValue =
		activeStatuses.length === 0
			? undefined
			: activeStatuses.length === 1
				? activeStatuses[0]
				: MULTIPLE_STATUSES

	const statusTabs = useMemo(() => {
		const base: Array<{ label: string; value: string | undefined; count: number }> = [
			{ label: 'All', value: undefined, count: rows.length },
			...AGENT_STATUSES.map((bucket) => ({
				label: STATUS_GROUP_META[bucket].label,
				value: bucket as string,
				count: statusCounts[bucket],
			})),
		]
		return base
	}, [rows.length, statusCounts])

	const teamTabs = useMemo(
		() =>
			teamChips.map(({ team, count }) => ({
				label: team,
				value: team as string | undefined,
				count,
			})),
		[teamChips],
	)

	const pills = buildAgentFilterPills({
		statuses: statusOnlyFilters,
		team: teamFilter,
		statusLabel,
	})
	const clearFilters = () => {
		setStatusFilter(undefined)
		setTeamFilter(undefined)
	}

	return (
		<TooltipProvider>
			{/* Search and Display live in the title row, beside the shared search and New. */}
			<PageHeader
				title="Agents"
				actions={
					<>
						<PageSearchInput value={query} onChange={onQueryChange} label="Search agents" />
						<DisplayPanel
							// The current DisplayPanel derives both the Ordering and Grouping
							// pickers from `columns`, so every property is offered as a sort and
							// group key. Sorting and grouping both fall back to name / a flat list
							// for keys this view doesn't implement (Activity), so the extra
							// options are inert rather than broken.
							columns={COLUMNS}
							columnVisibility={columnVisibility}
							onColumnVisibilityChange={(id, visible) =>
								setColumnVisibility((prev) => ({ ...prev, [id]: visible }))
							}
							filterSections={filterSections}
							activeFilterCount={pills.length}
							filtersLabel="Filters"
							resetFiltersLabel="Reset filters"
							resetLabel="Reset display"
							sort={sort}
							onSortChange={setSort}
							order={order}
							onOrderChange={setOrder}
							groupBy={groupBy}
							onGroupByChange={setGroupBy}
							onResetFilters={clearFilters}
							onResetToDefault={() => {
								clearFilters()
								setSort('name')
								setOrder('asc')
								setGroupBy(DEFAULT_GROUP_BY)
								setColumnVisibility({})
							}}
							showView={false}
						/>
					</>
				}
			/>
			{/* Status chips, then one outlined chip per team (mockup 15). Scrolls
			    sideways inside the row on touch widths rather than wrapping. */}
			<div className="flex min-h-7 flex-nowrap items-center gap-2 overflow-x-auto md:flex-wrap md:overflow-visible">
				<FilterTabs
					variant="chip"
					aria-label="Filter agents by status"
					className="shrink-0 overflow-visible"
					tabs={statusTabs}
					value={statusChipValue}
					onChange={setStatusFilter}
				/>
				{teamTabs.length > 0 && (
					<FilterTabs
						variant="chip-outline"
						aria-label="Filter agents by team"
						className="shrink-0 md:shrink md:flex-wrap md:overflow-visible"
						tabs={teamTabs}
						value={teamFilter}
						onChange={(team) => setTeamFilter(team === teamFilter ? undefined : team)}
					/>
				)}
			</div>
			{pills.length > 0 && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{pills.map((pill) => (
						<FilterChip
							key={pill.id}
							label={pill.label}
							value={pill.value}
							preserveCase
							onRemove={() => {
								if (pill.id === 'status') setStatusFilter(undefined)
								else setTeamFilter(undefined)
							}}
						/>
					))}
					{pills.length > 1 && (
						<Button
							variant="ghost"
							size="sm"
							className="h-[26px] px-1 text-[11.5px] font-semibold text-muted-foreground hover:text-foreground"
							onClick={clearFilters}
						>
							Clear all
						</Button>
					)}
				</div>
			)}

			{sortedRows.length === 0 ? (
				// A centred line, not a bordered empty-state card — the list this
				// replaces has no frame of its own to sit inside (mockup 2313).
				<p className="py-9 text-center text-[12.5px] text-muted-foreground">
					{words.length > 0 ? 'No agents match.' : 'No agents in that state right now.'}
				</p>
			) : (
				// Groups are separated by the header's own top padding, not a gap —
				// the hairlines have to run unbroken down the list (mockup 2315–2341).
				<div className="mt-3">
					<AgentsColumnHeader
						showTeam={showTeam}
						showActivity={showActivity}
						showSessions={showSessions}
					/>
					{groups.map((group) => (
						<AgentGroupSection
							key={group.id}
							workspaceId={workspaceId}
							group={group}
							showTeam={showTeam}
							showActivity={showActivity}
							showSessions={showSessions}
						/>
					))}
				</div>
			)}
		</TooltipProvider>
	)
}

// Column labels over the rows (mockup: Agent / Team / Latest / Sessions /
// Status). Hidden below md, where the row has no columns. Widths and
// breakpoints mirror AgentRowItem exactly so every label sits over its column.
function AgentsColumnHeader({
	showTeam,
	showActivity,
	showSessions,
}: {
	showTeam: boolean
	showActivity: boolean
	showSessions: boolean
}) {
	return (
		<div
			aria-hidden="true"
			className="hidden items-center border-b border-border-subtle px-2 pb-2.5 text-xs font-semibold text-muted-foreground md:flex"
		>
			<div className="flex min-w-0 flex-1 items-center gap-3.5">
				<span className="w-8 shrink-0" />
				<span className="min-w-0 flex-1">Agent</span>
				{showTeam && <span className="hidden w-36 shrink-0 xl:block">Team</span>}
				{showActivity && <span className="hidden w-32 shrink-0 lg:block xl:w-[150px]">Latest</span>}
				{showSessions && <span className="hidden w-16 shrink-0 text-right lg:block">Sessions</span>}
				<span className="w-[100px] shrink-0">Status</span>
			</div>
			{/* The row's "···" and Call/See why footprint. */}
			<span className="w-[100px] shrink-0" />
		</div>
	)
}

function AgentGroupSection({
	workspaceId,
	group,
	showTeam,
	showActivity,
	showSessions,
}: {
	workspaceId: string
	group: { id: string; label?: string; note?: string; rows: AgentRow[] }
	showTeam: boolean
	showActivity: boolean
	showSessions: boolean
}) {
	const rowProps = { workspaceId, showTeam, showActivity, showSessions }
	if (group.label === undefined) {
		return (
			<ul>
				{group.rows.map((row) => (
					<AgentRowItem key={row.agent.id} row={row} {...rowProps} />
				))}
			</ul>
		)
	}

	return (
		<section aria-label={group.label}>
			{/* Bold name and a muted count (mockup 15); the note, when there is one,
			    shares the line. */}
			<div className="flex items-baseline gap-2 px-2 pt-5 pb-2">
				<h3 className="shrink-0 text-sm font-bold text-foreground">{group.label}</h3>
				<span className="shrink-0 text-[13px] font-medium tabular-nums text-muted-foreground">
					{group.rows.length}
				</span>
				{group.note && (
					<span className="min-w-0 truncate text-xs text-muted-foreground/70">{group.note}</span>
				)}
			</div>
			<ul>
				{group.rows.length > 0 ? (
					group.rows.map((row) => <AgentRowItem key={row.agent.id} row={row} {...rowProps} />)
				) : (
					<li className="border-b border-border-subtle px-2 py-3 text-[13px] text-muted-foreground/70">
						{`No ${group.label.toLowerCase()} agents right now.`}
					</li>
				)}
			</ul>
		</section>
	)
}

function AgentRowItem({
	workspaceId,
	row,
	showTeam,
	showActivity,
	showSessions,
}: {
	workspaceId: string
	row: AgentRow
	showTeam: boolean
	showActivity: boolean
	showSessions: boolean
}) {
	const { agent, portrait, latestSession } = row
	const navigate = useNavigate()
	const outcome = agent.description?.split('\n')[0]?.trim() || 'No outcome set yet'
	const latest = describeFocus(portrait, latestSession)

	return (
		// A hairline under every row; the whole row is the click target (mockup 15).
		<li className="group/row flex items-center border-b border-border-subtle px-2 first:border-t">
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: agent.id }}
				className="group -ml-2 flex min-w-0 flex-1 items-center gap-3.5 rounded-xl py-3.5 pl-2 transition-colors duration-150 hover:bg-muted/50"
			>
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="md"
					id={agent.id}
					status={agentAvatarStatus(portrait)}
					className={cn(
						'size-8 shrink-0 rounded-lg text-[11px] font-bold',
						agentTileClass(portrait),
					)}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
					<span className="truncate text-[15px] font-semibold text-foreground">{agent.name}</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="truncate text-[13px] text-muted-foreground">{outcome}</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">{outcome}</TooltipContent>
					</Tooltip>
					{row.team !== NO_TEAM && (
						// The Team column takes over from xl; below it (or with the column off) the team
						// reads under the outcome, as in the narrow v3 list.
						<span
							className={cn('truncate text-[13px] text-muted-foreground', showTeam && 'xl:hidden')}
						>
							{row.team}
						</span>
					)}
					{showActivity && (
						// Below lg the Latest column is hidden, so its text wraps under the
						// outcome instead — readable on touch with no hover.
						<span
							data-testid="agent-latest-mobile"
							className="line-clamp-3 text-[13px] text-muted-foreground lg:hidden"
						>
							{latest}
						</span>
					)}
				</div>
				{showTeam && (
					<span className="hidden w-36 shrink-0 truncate text-[13px] text-muted-foreground xl:block">
						{row.team}
					</span>
				)}
				{showActivity && (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="hidden w-32 shrink-0 truncate text-[13px] text-muted-foreground lg:block xl:w-[150px]">
								{latest}
							</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">{latest}</TooltipContent>
					</Tooltip>
				)}
				{showSessions && (
					<span className="hidden w-16 shrink-0 text-right text-[13px] tabular-nums text-muted-foreground lg:block">
						{row.sessionCount}
					</span>
				)}
				<span className="shrink-0 text-[13px] md:w-[100px]">
					<AgentStatusPill status={portrait} pulse neutral />
				</span>
			</Link>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="mx-1 hidden size-7 shrink-0 text-muted-foreground/60 hover:text-foreground sm:inline-flex"
						aria-label={`More for ${agent.name}`}
					>
						<Ellipsis size={16} aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						onSelect={() =>
							navigate({
								to: '/$workspaceId/agents/$agentId',
								params: { workspaceId, agentId: agent.id },
							})
						}
					>
						Open
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							navigate({
								to: '/$workspaceId/chats/new',
								params: { workspaceId },
								search: { agentId: agent.id, agentName: agent.name },
							})
						}
					>
						Message
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{/* Row-level action. A sibling of the row link, not a child: a button inside
			    an anchor is invalid nesting. A failed agent gets See why, which opens it. */}
			{portrait === 'failed' ? (
				<Button
					asChild
					variant="outline"
					className="h-[30px] w-16 shrink-0 rounded-full px-0 text-[13px] font-semibold"
				>
					<Link to="/$workspaceId/agents/$agentId" params={{ workspaceId, agentId: agent.id }}>
						See why
					</Link>
				</Button>
			) : (
				<AgentCallButton agent={agent} variant="row" shortcut={false} />
			)}
		</li>
	)
}
