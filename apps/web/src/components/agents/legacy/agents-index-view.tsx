// PRE-V2 COMPONENT — governed by the `new-design` feature flag. Rendered only
// by the pre-v2 branch of the `agents/` routes when the flag is off.
// This directory dies with the flag; edit the v2 component instead.

import {
	AgentStatusPill,
	type PortraitStatus,
	describeFocus,
	getPortraitStatus,
	portraitStatusToFilter,
} from '@/components/agents/agent-portrait-card'
import type { DisplayPanelColumn } from '@/components/objects/data-table/display-panel'
import { DisplayPanel } from '@/components/objects/data-table/display-panel'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { FilterTabs } from '@/components/shared/filter-tabs'
import { Badge } from '@/components/ui/badge'
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
			<div className="mb-4 flex flex-wrap items-center gap-2 md:gap-3">
				<FilterTabs
					variant="pill"
					aria-label="Filter agents by status"
					className="min-w-0 flex-1"
					tabs={statusTabs}
					value={statusFilter}
					onChange={setStatusFilter}
				/>
				<DisplayPanel
					// The current DisplayPanel derives both the Ordering and Grouping
					// pickers from `columns`, so every property is offered as a sort and
					// group key. Sorting and grouping both fall back to name / a flat list
					// for keys this view doesn't implement (Activity), so the extra
					// options are inert rather than broken. The rebuilt panel in #1422
					// adds `orderingColumns` / `groupingColumns` to narrow them back down.
					columns={COLUMNS}
					columnVisibility={columnVisibility}
					onColumnVisibilityChange={(id, visible) =>
						setColumnVisibility((prev) => ({ ...prev, [id]: visible }))
					}
					statusFilter={statusFilter}
					onStatusFilterChange={setStatusFilter}
					statusesByType={{ agent: [...AGENT_STATUSES] }}
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
					iconOnly
				/>
			</div>

			{sortedRows.length === 0 ? (
				<EmptyState title="No agents in that state right now." />
			) : (
				<div className="space-y-6">
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
			<ul className="overflow-hidden rounded-xl border border-border bg-card">
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
			<div className="flex items-baseline gap-2 px-1 pb-2">
				<h3 className="eyebrow shrink-0 text-foreground">{group.label}</h3>
				<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
					{group.rows.length}
				</span>
				{group.note && (
					// One truncated line beside the count at every width (mockup 2320) —
					// hiding it below `sm` dropped the only explanation of the group.
					<span className="min-w-0 truncate text-xs text-muted-foreground">{group.note}</span>
				)}
			</div>
			<ul className="overflow-hidden rounded-xl border border-border bg-card">
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
					// Inline row inside the list frame, not a centred block (mockup 2324).
					<li className="px-4 py-3 text-[11.5px] text-muted-foreground">
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
	// Mockup 2330 puts a mono uppercase KIND badge beside the name. `ActorListItem`
	// carries the workspace-membership role when the row came from the members
	// join; everything else is just an agent.
	const kind = showKind ? agent.role?.trim() || 'Agent' : undefined
	const outcome = agent.description?.split('\n')[0]?.trim() || 'No outcome set yet'
	const sessionsLabel = `${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}`

	return (
		<li className="[&:not(:last-child)]:border-b [&:not(:last-child)]:border-border">
			{/* The whole row is the click target (mockup 2327), not just the name. */}
			<Link
				to="/$workspaceId/agents/$agentId"
				params={{ workspaceId, agentId: agent.id }}
				className="group flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-muted/50 md:gap-3.5"
			>
				<ActorAvatar
					name={agent.name}
					type={agent.type}
					size="lg"
					id={agent.id}
					className="shrink-0"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="flex min-w-0 items-center gap-2">
						<span className="truncate text-[13.5px] font-bold text-foreground">{agent.name}</span>
						{kind && (
							<Badge
								variant="outline"
								className="shrink-0 px-1.5 py-0 font-mono text-[9px] font-bold uppercase tracking-[0.09em]"
							>
								{kind}
							</Badge>
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
					<span className="shrink-0 text-[11px]">
						<AgentStatusPill status={portrait} />
					</span>
				)}
				<ChevronRight
					className="size-3.5 shrink-0 text-muted-foreground transition-colors duration-150 group-hover:text-foreground"
					aria-hidden
				/>
			</Link>
		</li>
	)
}
