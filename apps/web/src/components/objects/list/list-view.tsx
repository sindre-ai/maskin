import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import type { ActorListItem, ObjectResponse } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
import { getStatusColor } from '@/lib/constants'
import { getObjectGroupLabel, getObjectGroupValue } from '@/lib/objects-grouping'
import { useNavigate } from '@tanstack/react-router'
import type { GroupingState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import type { OnChangeFn } from '@tanstack/react-table'
import { ChevronRight } from 'lucide-react'
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react'
import { ListRow } from './list-row'

/** Rows shown per group before "Show N more" reveals the rest — keeps the
 *  collapsed-by-default list light, matching the mockup's per-group cap. */
const LIST_GROUP_ROW_CAP = 6

// Imperative handle the Objects route uses to read the first-visible row at
// navigate-away time and to restore the scroll position on a POP landing.
// Mirrors DataTableHandle: the route only ever calls these two methods, so the
// scroll-anchor + capture plumbing is unchanged by the view swap.
export interface ListViewHandle {
	getFirstVisibleRowId(): string | null
	scrollToRowId(rowId: string): void
}

interface ListViewProps {
	data: ObjectResponse[]
	workspaceId: string
	actors?: ActorListItem[]
	rowSelection: RowSelectionState
	onRowSelectionChange: OnChangeFn<RowSelectionState>
	columnVisibility: VisibilityState
	grouping?: GroupingState
	betStatuses?: Map<string, BetStatusResult>
	showBetStatusIndicator?: boolean
	hasNextPage?: boolean
	isFetchingNextPage?: boolean
	isError?: boolean
	fetchNextPage?: () => void
	isLoading?: boolean
	// Controlled group-expansion state (the same contract DataTable exposed).
	// Keyed by react-table's grouped-row id (`<columnId>:<groupValue>`) so the
	// map round-trips with blobs persisted by the DataTable era of this route.
	expanded: Record<string, boolean>
	onExpandedChange: (next: Record<string, boolean>) => void
	// Fires synchronously right before a row-open navigate (see DataTable).
	onCaptureViewState?: () => void
}

interface ListGroup {
	key: string
	value: string
	rows: ObjectResponse[]
}

export const ListView = forwardRef<ListViewHandle, ListViewProps>(function ListView(
	{
		data,
		workspaceId,
		actors,
		rowSelection,
		onRowSelectionChange,
		columnVisibility,
		grouping,
		betStatuses,
		showBetStatusIndicator,
		hasNextPage,
		isFetchingNextPage,
		isError,
		fetchNextPage,
		isLoading,
		expanded,
		onExpandedChange,
		onCaptureViewState,
	},
	ref,
) {
	const navigate = useNavigate()
	const scrollRef = useRef<HTMLDivElement>(null)
	const sentinelRef = useRef<HTMLDivElement>(null)
	const groupBy = grouping?.[0]

	// Groups preserve first-occurrence order across the API-sorted data, so the
	// visible order follows the sort/order the shared filter model emitted.
	const groups = useMemo<ListGroup[] | null>(() => {
		if (!groupBy) return null
		const byValue = new Map<string, ListGroup>()
		const order: ListGroup[] = []
		for (const object of data) {
			const value = getObjectGroupValue(object, groupBy)
			const existing = byValue.get(value)
			if (existing) existing.rows.push(object)
			else {
				const group: ListGroup = { key: `${groupBy}:${value}`, value, rows: [object] }
				byValue.set(value, group)
				order.push(group)
			}
		}
		return order
	}, [data, groupBy])

	// Per-group "Show N more" reveals are view-local and intentionally not
	// persisted — they are transient scrolling affordances, not view state.
	const [revealedGroups, setRevealedGroups] = useState<ReadonlySet<string>>(new Set())
	const revealGroup = useCallback((key: string) => {
		setRevealedGroups((prev) => new Set(prev).add(key))
	}, [])

	const selectedIdSet = useMemo(() => new Set(Object.keys(rowSelection)), [rowSelection])
	// Shift-click range anchor, kept per group so a range in one group never
	// anchors a selection in another (mirrors the board's selectionAnchorByStatus).
	const selectionAnchorRef = useRef<Record<string, string>>({})

	const setSelected = useCallback(
		(id: string, selected: boolean) => {
			onRowSelectionChange?.((prev) => {
				const next = { ...prev }
				if (selected) next[id] = true
				else delete next[id]
				return next
			})
		},
		[onRowSelectionChange],
	)

	// Any plain row select also re-anchors its group's shift-click range —
	// without this a shift-click right after a plain click reads a stale anchor
	// and collapses to a single-row select (mirrors the board's selectSingleCard
	// anchor write).
	const handleRowSelect = useCallback(
		(object: ObjectResponse, selected: boolean) => {
			const groupId = groupBy ? getObjectGroupValue(object, groupBy) : null
			selectionAnchorRef.current = { ...selectionAnchorRef.current, [groupId ?? '']: object.id }
			setSelected(object.id, selected)
		},
		[groupBy, setSelected],
	)

	const extendSelectionRange = useCallback(
		(groupId: string | null, targetId: string) => {
			const anchorKey = groupId ?? ''
			const anchorId = selectionAnchorRef.current[anchorKey]
			const orderedIds = groupBy
				? data.filter((o) => getObjectGroupValue(o, groupBy) === groupId).map((o) => o.id)
				: data.map((o) => o.id)
			if (Object.keys(rowSelection).length === 0 || !anchorId || !selectedIdSet.has(anchorId)) {
				setSelected(targetId, true)
				selectionAnchorRef.current = { ...selectionAnchorRef.current, [anchorKey]: targetId }
				return
			}
			const anchorIndex = orderedIds.indexOf(anchorId)
			const targetIndex = orderedIds.indexOf(targetId)
			if (anchorIndex < 0 || targetIndex < 0) {
				setSelected(targetId, true)
				selectionAnchorRef.current = { ...selectionAnchorRef.current, [anchorKey]: targetId }
				return
			}
			const start = Math.min(anchorIndex, targetIndex)
			const end = Math.max(anchorIndex, targetIndex)
			const range = orderedIds.slice(start, end + 1)
			onRowSelectionChange?.((prev) => {
				const next = { ...prev }
				for (const id of range) next[id] = true
				return next
			})
		},
		[groupBy, data, rowSelection, selectedIdSet, setSelected, onRowSelectionChange],
	)

	const handleOpen = useCallback(
		(objectId: string) => {
			// Snapshot view state before pushing the detail route — the POP
			// landing back to this list reads it (same contract as DataTable).
			onCaptureViewState?.()
			navigate({
				to: '/$workspaceId/objects/$objectId',
				params: { workspaceId, objectId },
			})
		},
		[navigate, workspaceId, onCaptureViewState],
	)

	const toggleGroup = useCallback(
		(group: ListGroup) => {
			const open = expanded[group.key] === true
			onExpandedChange({ ...expanded, [group.key]: !open })
		},
		[expanded, onExpandedChange],
	)

	// Refs mirror current props so the imperative handle stays identity-stable
	// (no dep array) while reading fresh values inside its methods — same
	// pattern DataTable uses for its virtualizer + row model.
	const expandedRef = useRef(expanded)
	expandedRef.current = expanded
	const onExpandedChangeRef = useRef(onExpandedChange)
	onExpandedChangeRef.current = onExpandedChange
	const dataRef = useRef(data)
	dataRef.current = data
	const groupByRef = useRef(groupBy)
	groupByRef.current = groupBy

	useImperativeHandle(
		ref,
		() => ({
			getFirstVisibleRowId: () => {
				const scroller = scrollRef.current
				if (!scroller) return null
				const scrollerTop = scroller.getBoundingClientRect().top
				const rows = scroller.querySelectorAll<HTMLElement>('[data-obj-id]')
				for (const el of rows) {
					if (el.getBoundingClientRect().bottom > scrollerTop + 1) {
						return el.dataset.objId ?? null
					}
				}
				return null
			},
			scrollToRowId: (rowId: string) => {
				const scroller = scrollRef.current
				if (!scroller) return
				// A collapsed group keeps its rows out of the DOM — reopen the
				// group that owns the target so it exists before we scroll.
				const groupByValue = groupByRef.current
				if (groupByValue) {
					const target = dataRef.current.find((o) => o.id === rowId)
					if (target) {
						const groupKey = `${groupByValue}:${getObjectGroupValue(target, groupByValue)}`
						if (expandedRef.current[groupKey] !== true) {
							onExpandedChangeRef.current?.({
								...expandedRef.current,
								[groupKey]: true,
							})
						}
					}
				}
				requestAnimationFrame(() => {
					const nodes = scroller.querySelectorAll<HTMLElement>('[data-obj-id]')
					for (const el of nodes) {
						if (el.dataset.objId === rowId) {
							el.scrollIntoView({ block: 'start' })
							break
						}
					}
				})
			},
		}),
		[],
	)

	// Infinite scroll sentinel — mirror of DataTable's: gated on hasNextPage /
	// isFetchingNextPage / isError so a failure doesn't retry-loop.
	useEffect(() => {
		if (!sentinelRef.current || !hasNextPage || isFetchingNextPage || isError) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting) fetchNextPage?.()
			},
			{ root: scrollRef.current, rootMargin: '200px' },
		)
		observer.observe(sentinelRef.current)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, isError, fetchNextPage])

	const renderRows = (rows: ObjectResponse[]) =>
		rows.map((object) => (
			<ListRow
				key={object.id}
				object={object}
				workspaceId={workspaceId}
				actors={actors}
				isSelected={selectedIdSet.has(object.id)}
				onSelect={(selected) => handleRowSelect(object, selected)}
				onOpen={handleOpen}
				onShiftClick={(id) =>
					extendSelectionRange(groupBy ? getObjectGroupValue(object, groupBy) : null, id)
				}
				betStatus={object.type === 'bet' ? betStatuses?.get(object.id) : undefined}
				showBetStatusIndicator={showBetStatusIndicator}
				columnVisibility={columnVisibility}
			/>
		))

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		)
	}

	if (data.length === 0) {
		return (
			<EmptyState title="No objects found" description="Create your first object to get started" />
		)
	}

	return (
		<div
			ref={scrollRef}
			className={cn('flex-1 min-h-0 overflow-auto rounded-md border', 'touch-pan-y')}
		>
			<ul className="m-0 list-none p-0" aria-label="Objects">
				{groups === null
					? renderRows(data)
					: groups.map((group) => {
							const open = expanded[group.key] === true
							const capped = revealedGroups.has(group.key)
								? group.rows
								: group.rows.slice(0, LIST_GROUP_ROW_CAP)
							const hiddenCount = group.rows.length - LIST_GROUP_ROW_CAP
							const statusDot = groupBy === 'status' ? getStatusColor(group.value) : null
							return (
								<li key={group.key}>
									<div className="flex w-full items-center gap-2 border-b border-border bg-muted/30 px-4 py-2 hover:bg-muted/50">
										<button
											type="button"
											onClick={() => toggleGroup(group)}
											aria-expanded={open}
											className="flex flex-1 items-center gap-2 text-left"
										>
											<ChevronRight
												size={14}
												aria-hidden="true"
												className={cn(
													'shrink-0 text-muted-foreground transition-transform',
													open && 'rotate-90',
												)}
											/>
											{statusDot && (
												<span
													aria-hidden="true"
													className={cn(
														'h-1.5 w-1.5 shrink-0 rounded-[2px] bg-current',
														statusDot.text,
													)}
												/>
											)}
											<span className="text-sm font-medium">
												{getObjectGroupLabel(groupBy, group.value, actors)}
											</span>
											<span className="text-xs tabular-nums text-muted-foreground">
												{group.rows.length}
											</span>
										</button>
									</div>
									{open && (
										<>
											{renderRows(capped)}
											{hiddenCount > 0 && !revealedGroups.has(group.key) && (
												<button
													type="button"
													onClick={() => revealGroup(group.key)}
													className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
												>
													Show {hiddenCount} more
													<ChevronRight size={12} aria-hidden="true" className="rotate-90" />
												</button>
											)}
										</>
									)}
								</li>
							)
						})}
			</ul>
			<div ref={sentinelRef} className="h-1" />
			{isFetchingNextPage && (
				<div className="flex items-center justify-center py-4">
					<Spinner />
				</div>
			)}
		</div>
	)
})
