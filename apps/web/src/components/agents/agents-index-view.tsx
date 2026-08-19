import {
	AgentStatusPill,
	type PortraitStatus,
	describeFocus,
	getPortraitStatus,
	portraitStatusToFilter,
} from '@/components/agents/agent-portrait-card'
import type { DisplayFilterSectionModel } from '@/components/objects/data-table/display-filter-section'
import type { DisplayPanelColumn } from '@/components/objects/data-table/display-panel'
import { DisplayPanel } from '@/components/objects/data-table/display-panel'
import { ActorAvatar, getActorAvatarPaletteClass } from '@/components/shared/actor-avatar'
import { FilterTabs } from '@/components/shared/filter-tabs'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import {
	deriveAgentKind,
	deriveAgentStatus,
	getLatestSession,
	groupSessionsByAgent,
} from '@/lib/agent-status'
import type { ActorListItem, DisplaySettingsBody, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

const AGENTS_DISPLAY_KEY = 'agents'

export const AGENT_STATUSES = ['working', 'idle', 'failed'] as const
type StatusBucket = (typeof AGENT_STATUSES)[number]

const COLUMNS: DisplayPanelColumn[] = [
	{ id: 'name', label: 'Name', canHide: false },
	{ id: 'kind', label: 'Kind', canHide: true },
	{ id: 'activity', label: 'Activity', canHide: true },
	{ id: 'sessions', label: 'Sessions', canHide: true },
	{ id: 'status', label: 'Status', canHide: true },
]

// Ordering / Grouping pickers point at the same property rail, but not every
// column is a sensible sort key (ordering by free-text activity is noise) and
// only status/kind produce stable section headers.
const ORDERING_COLUMNS: DisplayPanelColumn[] = [
	{ id: 'name', label: 'Name', canHide: false },
	{ id: 'kind', label: 'Kind', canHide: false },
	{ id: 'status', label: 'Status', canHide: false },
	{ id: 'sessions', label: 'Sessions', canHide: false },
]
const GROUPING_COLUMNS: DisplayPanelColumn[] = [
	{ id: 'status', label: 'Status', canHide: false },
	{ id: 'kind', label: 'Kind', canHide: false },
]

// Leading dot for each status chip — semantic tokens only, never a raw colour.
const STATUS_DOT: Record<StatusBucket, string> = {
	working: 'bg-status-in_progress-text',
	idle: 'bg-muted-foreground',
	failed: 'bg-status-failed-text',
}

export const STATUS_GROUP_META: Record<StatusBucket, { label: string; note: string }> = {
	working: { label: 'Working', note: 'Agents with a session in progress' },
	idle: { label: 'Idle', note: 'Standing by for their next run' },
	failed: { label: 'Failed', note: 'Last run errored' },
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
}

export function AgentsIndexView({
	workspaceId,
	agents,
	sessions,
}: {
	workspaceId: string
	agents: ActorListItem[]
	sessions: SessionResponse[]
}) {
	const [sort, setSort] = useState('name')
	const [order, setOrder] = useState<'asc' | 'desc'>('asc')
	const [groupBy, setGroupBy] = useState<string | undefined>('status')
	const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({})
	const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined)

	// Per-actor display settings — same hydration-gated, debounced write-through
	// rail the Objects page uses (see objects/index.tsx), keyed by the literal
	// `agents` object_type so group/order/visibility choices survive navigation.
	const displaySettingsQuery = useUserDisplaySettings(workspaceId, AGENTS_DISPLAY_KEY)
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

	const rows = useMemo<AgentRow[]>(
		() =>
			agents.map((agent) => {
				const sessionStatus = deriveAgentStatus(agent.id, sessionsByAgent)
				return {
					agent,
					portrait: getPortraitStatus(agent, sessionStatus),
					latestSession: getLatestSession(agent.id, sessionsByAgent),
					sessionCount: sessionsByAgent.get(agent.id)?.length ?? 0,
				}
			}),
		[agents, sessionsByAgent],
	)

	const activeStatuses = useMemo(
		() => (statusFilter ? statusFilter.split(',').filter(Boolean) : []),
		[statusFilter],
	)

	const visibleRows = useMemo(
		() =>
			rows.filter((row) => {
				const bucket = portraitStatusToFilter(row.portrait)
				return activeStatuses.length === 0 || activeStatuses.includes(bucket)
			}),
		[rows, activeStatuses],
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
				activeStatuses.length === 0 ? true : activeStatuses.includes(b),
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
		return [{ id: 'all', label: undefined, note: undefined, rows: sortedRows }]
	}, [groupBy, activeStatuses, sortedRows])

	const showKind = columnVisibility.kind !== false
	const showActivity = columnVisibility.activity !== false
	const showSessions = columnVisibility.sessions !== false
	const showStatus = columnVisibility.status !== false

	// Counts come off the pre-filter `rows` so a chip's number stays stable while
	// that chip is the active filter (mockup 2290–2293).
	const statusCounts = useMemo(() => {
		const counts: Record<StatusBucket, number> = { working: 0, idle: 0, failed: 0 }
		for (const row of rows) counts[portraitStatusToFilter(row.portrait)]++
		return counts
	}, [rows])

	// The Display menu's Status row (mockup 2304). Same buckets and the same
	// pre-filter counts the chip strip draws, built once so the two can't
	// disagree. Not pinnable — the chip strip above already *is* the pinned row.
	const filterSections = useMemo<DisplayFilterSectionModel[]>(
		() => [
			{
				id: 'status',
				label: 'Status',
				summary:
					activeStatuses.length > 0
						? activeStatuses
								.map((bucket) => STATUS_GROUP_META[bucket as StatusBucket]?.label ?? bucket)
								.join(', ')
						: 'All',
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
		],
		[activeStatuses, statusCounts],
	)

	const statusTabs = useMemo(
		() => [
			{ label: 'All', value: undefined, count: rows.length },
			...AGENT_STATUSES.map((bucket) => ({
				label: STATUS_GROUP_META[bucket].label,
				value: bucket as string,
				count: statusCounts[bucket],
				dot: STATUS_DOT[bucket],
			})),
		],
		[rows.length, statusCounts],
	)

	return (
		<div>
			{/* Chips left, Display right, on one 28px line (mockup 2290–2308). */}
			<div className="flex min-h-7 flex-wrap items-center gap-1.5 px-0.5">
				<FilterTabs
					variant="pill"
					aria-label="Filter agents by status"
					className="min-w-0 flex-1"
					tabs={statusTabs}
					value={statusFilter}
					onChange={setStatusFilter}
				/>
				<DisplayPanel
					columns={COLUMNS}
					orderingColumns={ORDERING_COLUMNS}
					groupingColumns={GROUPING_COLUMNS}
					columnVisibility={columnVisibility}
					onColumnVisibilityChange={(id, visible) =>
						setColumnVisibility((prev) => ({ ...prev, [id]: visible }))
					}
					statusFilter={statusFilter}
					onStatusFilterChange={setStatusFilter}
					filterSections={filterSections}
					sort={sort}
					onSortChange={setSort}
					order={order}
					onOrderChange={setOrder}
					groupBy={groupBy}
					onGroupByChange={setGroupBy}
					onResetFilters={() => setStatusFilter(undefined)}
					onResetToDefault={() => {
						setStatusFilter(undefined)
						setSort('name')
						setOrder('asc')
						setGroupBy('status')
						setColumnVisibility({})
					}}
					showView={false}
				/>
			</div>

			{sortedRows.length === 0 ? (
				// A centred line, not a bordered empty-state card — the list this
				// replaces has no frame of its own to sit inside (mockup 2313).
				<p className="px-3.5 py-9 text-center text-[12.5px] text-muted-foreground">
					No agents in that state right now.
				</p>
			) : (
				// Groups are separated by the header's own top padding, not a gap —
				// the hairlines have to run unbroken down the list (mockup 2315–2341).
				<div className="mt-3">
					{groups.map((group) => (
						<AgentGroupSection
							key={group.id}
							workspaceId={workspaceId}
							group={group}
							showKind={showKind}
							showActivity={showActivity}
							showSessions={showSessions}
							showStatus={showStatus}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function AgentGroupSection({
	workspaceId,
	group,
	showKind,
	showActivity,
	showSessions,
	showStatus,
}: {
	workspaceId: string
	group: { id: string; label?: string; note?: string; rows: AgentRow[] }
	showKind: boolean
	showActivity: boolean
	showSessions: boolean
	showStatus: boolean
}) {
	if (group.label === undefined) {
		return (
			<ul>
				{group.rows.map((row) => (
					<AgentRowItem
						key={row.agent.id}
						workspaceId={workspaceId}
						row={row}
						showKind={showKind}
						showActivity={showActivity}
						showSessions={showSessions}
						showStatus={showStatus}
					/>
				))}
			</ul>
		)
	}

	return (
		<section aria-label={group.label}>
			{/* Not the mono `.eyebrow` — the agents list marks a group with a tighter
			    11px uppercase label so the count and the note can share its line
			    (mockup 2318–2321). */}
			<div className="flex items-baseline gap-[9px] px-1 pt-3.5 pb-1.5">
				<h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground">
					{group.label}
				</h3>
				<span className="shrink-0 text-[11px] font-semibold tabular-nums text-border-strong">
					{group.rows.length}
				</span>
				{group.note && (
					// One truncated line beside the count at every width (mockup 2320) —
					// hiding it below `sm` dropped the only explanation of the group.
					<span className="min-w-0 truncate text-[11px] text-muted-foreground/70">
						{group.note}
					</span>
				)}
			</div>
			<ul>
				{group.rows.length > 0 ? (
					group.rows.map((row) => (
						<AgentRowItem
							key={row.agent.id}
							workspaceId={workspaceId}
							row={row}
							showKind={showKind}
							showActivity={showActivity}
							showSessions={showSessions}
							showStatus={showStatus}
						/>
					))
				) : (
					// Sits on the same hairline the rows do, so an empty group reads as
					// part of the list rather than a gap in it (mockup 2324).
					<li className="border-b border-border-subtle px-3.5 py-3 text-[11.5px] text-muted-foreground/70">
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
	showKind,
	showActivity,
	showSessions,
	showStatus,
}: {
	workspaceId: string
	row: AgentRow
	showKind: boolean
	showActivity: boolean
	showSessions: boolean
	showStatus: boolean
}) {
	const { agent, portrait, latestSession } = row
	// Mockup 2330 puts a mono uppercase KIND badge beside the name, tinted in the
	// agent's own identity colour rather than outlined. `ActorListItem` carries the
	// workspace-membership role when the row came from the members join;
	// everything else is just an agent.
	const kind = showKind ? agent.role?.trim() || 'Agent' : undefined
	const outcome = agent.description?.split('\n')[0]?.trim() || 'No outcome set yet'
	const sessionsLabel = `${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}`

	return (
		// A hairline under every row, including the last — the group below butts
		// straight onto it, so the list reads as one unbroken column of rows rather
		// than a stack of framed cards (mockup 2327).
		<li className="border-b border-border-subtle">
			{/* The whole row is the click target (mockup 2327), not just the name. */}
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: agent.id }}
				className="group flex items-center gap-3 rounded-xl px-3.5 py-[15px] transition-colors duration-150 hover:bg-muted/50 md:gap-3.5"
			>
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="lg"
					tone="strong"
					id={agent.id}
					className="size-10 shrink-0 text-[15px] font-extrabold"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex min-w-0 items-center gap-[7px]">
						<span className="truncate text-[13.5px] font-bold text-foreground">{agent.name}</span>
						{kind && (
							<span
								className={cn(
									'shrink-0 rounded-[5px] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase leading-none tracking-[0.09em]',
									getActorAvatarPaletteClass(agent.id),
								)}
							>
								{kind}
							</span>
						)}
					</span>
					<span className="truncate text-xs text-muted-foreground" title={outcome}>
						{outcome}
					</span>
				</div>
				{showActivity && (
					// "What it's doing now" (mockup 2333) shares the sessions column's
					// breakpoint — at 768px the row otherwise carried a name and a status
					// and nothing about the work.
					<span className="hidden w-[140px] shrink-0 truncate text-[11.5px] text-muted-foreground md:block lg:w-[200px]">
						{describeFocus(portrait, latestSession)}
					</span>
				)}
				{showSessions && (
					<span className="hidden w-[74px] shrink-0 text-[11.5px] tabular-nums text-muted-foreground md:block">
						{sessionsLabel}
					</span>
				)}
				{showStatus && (
					// A dot and a coloured label, not a filled pill — at row density the
					// plate reads as a second badge beside the kind (mockup 2337).
					<span className="shrink-0 text-[11px]">
						<AgentStatusPill status={portrait} variant="inline" />
					</span>
				)}
				<ChevronRight
					className="size-3.5 shrink-0 text-border-strong transition-colors duration-150 group-hover:text-foreground"
					aria-hidden
				/>
			</Link>
		</li>
	)
}
