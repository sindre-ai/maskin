import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import { type BetStatusResult, type BetStatusState, classifyObjectStatus } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
import { useNavigate } from '@tanstack/react-router'
import type { OnChangeFn, RowSelectionState } from '@tanstack/react-table'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ObjectCard } from './data-table/object-card'

const FLEET_TYPES = ['insight', 'bet', 'task'] as const
export type FleetType = (typeof FLEET_TYPES)[number]

// Sort order per the AC — top-of-list is what needs a human, bottom is idle.
// Matches the ordering in the Phase B interactive prototype and the
// `waiting → stalled → progressing → idle` phrase in the bet's AC.
const STATE_ORDER: Record<BetStatusState, number> = {
	waiting_on_human: 0,
	stalled: 1,
	progressing: 2,
	idle: 3,
}

const SECTION_LABEL: Record<FleetType, { singular: string; plural: string }> = {
	insight: { singular: 'Insight', plural: 'Insights' },
	bet: { singular: 'Bet', plural: 'Bets' },
	task: { singular: 'Task', plural: 'Tasks' },
}

const IDLE_LABEL: Record<FleetType, { singular: string; plural: string }> = {
	insight: { singular: 'insight', plural: 'insights' },
	bet: { singular: 'bet', plural: 'bets' },
	task: { singular: 'task', plural: 'tasks' },
}

// Rows are classified once, then sorted. Bets pull from the pre-built map
// (child-task aware — see `buildBetStatuses`); everything else derives from
// the object itself (`classifyObjectStatus`). Kept as one helper so the
// unit test can lock the ordering without touching the component render.
export function classifyFleetRow(
	obj: ObjectResponse,
	betStatuses: Map<string, BetStatusResult>,
	now: Date = new Date(),
): BetStatusState {
	if (obj.type === 'bet') return betStatuses.get(obj.id)?.state ?? 'idle'
	return classifyObjectStatus(obj, now)
}

export interface FleetSection {
	type: FleetType
	rows: Array<{ obj: ObjectResponse; state: BetStatusState }>
	totalCount: number
	waitingCount: number
	idleCount: number
	activeCount: number
}

export function buildFleetSections(
	objects: ObjectResponse[],
	betStatuses: Map<string, BetStatusResult>,
	now: Date = new Date(),
): FleetSection[] {
	const byType = new Map<FleetType, Array<{ obj: ObjectResponse; state: BetStatusState }>>()
	for (const type of FLEET_TYPES) byType.set(type, [])

	for (const obj of objects) {
		if (!isFleetType(obj.type)) continue
		const rows = byType.get(obj.type)
		if (!rows) continue
		rows.push({ obj, state: classifyFleetRow(obj, betStatuses, now) })
	}

	for (const rows of byType.values()) {
		rows.sort((a, b) => {
			const so = STATE_ORDER[a.state] - STATE_ORDER[b.state]
			if (so !== 0) return so
			const ta = a.obj.updatedAt ? Date.parse(a.obj.updatedAt) : 0
			const tb = b.obj.updatedAt ? Date.parse(b.obj.updatedAt) : 0
			return tb - ta
		})
	}

	return FLEET_TYPES.map((type) => {
		const rows = byType.get(type) ?? []
		let waitingCount = 0
		let idleCount = 0
		for (const r of rows) {
			if (r.state === 'waiting_on_human') waitingCount++
			else if (r.state === 'idle') idleCount++
		}
		return {
			type,
			rows,
			totalCount: rows.length,
			waitingCount,
			idleCount,
			activeCount: rows.length - idleCount,
		}
	})
}

function isFleetType(type: string): type is FleetType {
	return type === 'insight' || type === 'bet' || type === 'task'
}

// `IndicatorBadgeRow` only reads `result.state`, so a state-only synthetic
// result covers the non-bet rows without wiring the popover payload the
// row indicator doesn't use.
function stateAsResult(state: BetStatusState): BetStatusResult {
	return { state, pendingAction: null, decisionsSoFar: [] }
}

interface FleetStatusViewProps {
	objects: ObjectResponse[]
	betStatuses: Map<string, BetStatusResult>
	workspaceId: string
	actors?: ActorListItem[]
	rowSelection: RowSelectionState
	onRowSelectionChange: OnChangeFn<RowSelectionState>
	isLoading?: boolean
	isError?: boolean
	hasNextPage?: boolean
	isFetchingNextPage?: boolean
	fetchNextPage?: () => void
	onCaptureViewState?: () => void
}

export function FleetStatusView({
	objects,
	betStatuses,
	workspaceId,
	actors,
	rowSelection,
	onRowSelectionChange,
	isLoading,
	isError,
	hasNextPage,
	isFetchingNextPage,
	fetchNextPage,
	onCaptureViewState,
}: FleetStatusViewProps) {
	const navigate = useNavigate()
	const sentinelRef = useRef<HTMLDivElement>(null)

	const [collapsed, setCollapsed] = useState<Record<FleetType, boolean>>({
		insight: false,
		bet: false,
		task: false,
	})
	const [idleExpanded, setIdleExpanded] = useState<Record<FleetType, boolean>>({
		insight: false,
		bet: false,
		task: false,
	})

	const sections = useMemo(() => buildFleetSections(objects, betStatuses), [objects, betStatuses])

	const toggleSection = useCallback((type: FleetType) => {
		setCollapsed((prev) => ({ ...prev, [type]: !prev[type] }))
	}, [])

	const toggleIdle = useCallback((type: FleetType) => {
		setIdleExpanded((prev) => ({ ...prev, [type]: !prev[type] }))
	}, [])

	const handleRowClick = useCallback(
		(objectId: string) => {
			onCaptureViewState?.()
			navigate({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId },
			})
		},
		[navigate, workspaceId, onCaptureViewState],
	)

	const handleRowSelect = useCallback(
		(id: string, selected: boolean) => {
			onRowSelectionChange((prev) => {
				const next: RowSelectionState = { ...prev }
				if (selected) next[id] = true
				else delete next[id]
				return next
			})
		},
		[onRowSelectionChange],
	)

	// Infinite scroll — mirrors the DataTable sentinel pattern so long lists
	// don't stop at the first page. The idle-fold hides idle rows visually
	// but does NOT stop the underlying pagination from pulling more rows in.
	useEffect(() => {
		if (!sentinelRef.current || !hasNextPage || isFetchingNextPage || isError) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) fetchNextPage?.()
			},
			{ rootMargin: '200px' },
		)
		observer.observe(sentinelRef.current)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, isError, fetchNextPage])

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		)
	}

	if (objects.length === 0) {
		return (
			<EmptyState title="No objects found" description="Create your first object to get started" />
		)
	}

	return (
		<div className="flex flex-col gap-4 overflow-y-auto pb-6 md:px-6">
			{sections.map((section) => (
				<SectionCard
					key={section.type}
					section={section}
					collapsed={collapsed[section.type]}
					idleExpanded={idleExpanded[section.type]}
					onToggleCollapse={() => toggleSection(section.type)}
					onToggleIdle={() => toggleIdle(section.type)}
					workspaceId={workspaceId}
					actors={actors}
					rowSelection={rowSelection}
					onRowSelect={handleRowSelect}
					onRowClick={handleRowClick}
					betStatuses={betStatuses}
				/>
			))}
			<div ref={sentinelRef} className="h-1" />
			{isFetchingNextPage && (
				<div className="flex items-center justify-center py-4">
					<Spinner />
				</div>
			)}
		</div>
	)
}

interface SectionCardProps {
	section: FleetSection
	collapsed: boolean
	idleExpanded: boolean
	onToggleCollapse: () => void
	onToggleIdle: () => void
	workspaceId: string
	actors?: ActorListItem[]
	rowSelection: RowSelectionState
	onRowSelect: (id: string, selected: boolean) => void
	onRowClick: (id: string) => void
	betStatuses: Map<string, BetStatusResult>
}

function SectionCard({
	section,
	collapsed,
	idleExpanded,
	onToggleCollapse,
	onToggleIdle,
	workspaceId,
	actors,
	rowSelection,
	onRowSelect,
	onRowClick,
	betStatuses,
}: SectionCardProps) {
	const { type, rows, totalCount, waitingCount, idleCount, activeCount } = section
	const labels = SECTION_LABEL[type]
	const idleLabel = IDLE_LABEL[type]
	const visibleRows = idleExpanded ? rows : rows.filter((r) => r.state !== 'idle')

	return (
		<section
			data-fleet-section={type}
			className="rounded-md border border-border bg-card overflow-hidden mx-4 md:mx-0"
		>
			<button
				type="button"
				onClick={onToggleCollapse}
				aria-expanded={!collapsed}
				aria-controls={`fleet-section-body-${type}`}
				className={cn(
					'flex w-full items-center gap-2 px-4 py-2.5 text-left',
					'hover:bg-accent/30 transition-colors',
					!collapsed && 'border-b border-border',
				)}
			>
				<ChevronDown
					size={14}
					aria-hidden="true"
					className={cn(
						'shrink-0 text-muted-foreground transition-transform',
						collapsed && '-rotate-90',
					)}
				/>
				<h2 className="text-sm font-semibold tracking-tight">
					{totalCount === 1 ? labels.singular : labels.plural}
				</h2>
				<span
					className="text-xs text-muted-foreground tabular-nums"
					aria-label={`${totalCount} total`}
				>
					· {totalCount}
				</span>
				{waitingCount > 0 && (
					<span
						data-fleet-waiting-pill=""
						className={cn(
							'ml-auto inline-flex items-center gap-1.5 rounded-full',
							'px-2 py-0.5 text-xs font-semibold',
							'border border-error/25 bg-error/10 text-error',
						)}
						aria-label={`${waitingCount} waiting on human`}
					>
						<span
							aria-hidden="true"
							className="inline-block h-1.5 w-1.5 rounded-full bg-error ring-2 ring-error/25"
						/>
						{waitingCount} waiting
					</span>
				)}
			</button>

			{!collapsed && (
				<div id={`fleet-section-body-${type}`}>
					{totalCount === 0 ? (
						<div className="px-4 py-6 text-center text-sm text-muted-foreground">
							No {labels.plural.toLowerCase()} yet
						</div>
					) : (
						<>
							{visibleRows.map(({ obj, state }) => {
								const betStatus =
									obj.type === 'bet' ? betStatuses.get(obj.id) : stateAsResult(state)
								return (
									<ObjectCard
										key={obj.id}
										object={obj}
										workspaceId={workspaceId}
										actors={actors}
										isSelected={!!rowSelection[obj.id]}
										onSelect={(selected) => onRowSelect(obj.id, selected)}
										onClick={() => onRowClick(obj.id)}
										betStatus={betStatus}
									/>
								)
							})}
							{idleCount > 0 && (
								<button
									type="button"
									onClick={onToggleIdle}
									aria-expanded={idleExpanded}
									className={cn(
										'w-full px-4 py-2 text-left text-xs text-muted-foreground',
										'bg-secondary/40 hover:bg-secondary transition-colors',
										'border-t border-border',
									)}
								>
									<span aria-hidden="true">{idleExpanded ? '▾' : '▸'} </span>
									{idleExpanded ? 'Hide' : 'Show'} {idleCount} idle{' '}
									{idleCount === 1 ? idleLabel.singular : idleLabel.plural}
								</button>
							)}
							{activeCount === 0 && !idleExpanded && (
								<div className="px-4 py-4 text-center text-xs text-muted-foreground">
									All {labels.plural.toLowerCase()} are idle
								</div>
							)}
						</>
					)}
				</div>
			)}
		</section>
	)
}
