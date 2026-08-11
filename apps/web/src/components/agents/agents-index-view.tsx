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
import { Input } from '@/components/ui/input'
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
import { Search } from 'lucide-react'
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
	const [query, setQuery] = useState('')
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
				if (activeStatuses.length > 0 && !activeStatuses.includes(bucket)) return false
				return matchesAgentQuery(row.agent, query)
			}),
		[rows, activeStatuses, query],
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
			const buckets: StatusBucket[] =
				activeStatuses.length > 0
					? (activeStatuses as StatusBucket[])
					: ['working', 'idle', 'failed']
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

	return (
		<div>
			<div className="mb-4 flex flex-wrap items-center gap-2 md:gap-3">
				<div className="relative min-w-0 max-w-full flex-1 sm:max-w-xs">
					<Search
						size={14}
						className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search agents…"
						aria-label="Search agents"
						className="h-8 pl-8 text-sm"
					/>
				</div>
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
					statusesByType={{ agent: [...AGENT_STATUSES] }}
					sort={sort}
					onSortChange={setSort}
					order={order}
					onOrderChange={setOrder}
					groupBy={groupBy}
					onGroupByChange={setGroupBy}
					onResetFilters={() => setStatusFilter(undefined)}
					showView={false}
					iconOnly
				/>
			</div>

			{sortedRows.length === 0 ? (
				<EmptyState
					title={query ? 'No matches' : 'No agents match the filters'}
					description={query ? 'Try a different search term.' : 'Try clearing the status filter.'}
				/>
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
			<ul className="overflow-hidden rounded-lg border border-border bg-bg-surface">
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
			<div className="flex items-baseline gap-2 px-1 pb-1.5">
				<h3 className="shrink-0 text-xs font-semibold uppercase tracking-wide text-foreground">
					{group.label}
				</h3>
				<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
					{group.rows.length}
				</span>
				{group.note && (
					<span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
						{group.note}
					</span>
				)}
			</div>
			{group.rows.length > 0 ? (
				<ul className="overflow-hidden rounded-lg border border-border bg-bg-surface">
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
			) : (
				<EmptyState compact title={`No ${group.label.toLowerCase()} agents`} className="py-6" />
			)}
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
	const segments: string[] = []
	if (showKind) segments.push(deriveAgentKind(agent))
	if (showActivity) segments.push(describeFocus(portrait, latestSession))
	if (showSessions) {
		segments.push(`${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}`)
	}
	const metaLine = segments.join(' · ')

	return (
		<li className="flex items-center gap-3 px-4 py-2.5 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-border">
			<ActorAvatar name={agent.name} type={agent.type} size="md" className="shrink-0" />
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Link
					to="/$workspaceId/agents/$agentId"
					params={{ workspaceId, agentId: agent.id }}
					className="truncate text-sm font-medium text-foreground hover:underline"
				>
					{agent.name}
				</Link>
				<p
					className="truncate text-xs text-muted-foreground"
					title={metaLine}
					aria-label={metaLine}
				>
					{metaLine || '\u00A0'}
				</p>
			</div>
			{showStatus && (
				<div className="shrink-0 pl-1">
					<AgentStatusPill status={portrait} />
				</div>
			)}
		</li>
	)
}

function matchesAgentQuery(
	agent: { name: string; description?: string | null },
	query: string,
): boolean {
	if (!query) return true
	const needle = query.trim().toLowerCase()
	if (!needle) return true
	return (
		agent.name.toLowerCase().includes(needle) ||
		(agent.description?.toLowerCase().includes(needle) ?? false) ||
		deriveAgentKind(agent).toLowerCase().includes(needle)
	)
}
