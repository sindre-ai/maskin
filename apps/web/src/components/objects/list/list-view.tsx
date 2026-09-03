import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { Button } from '@/components/ui/button'
import { useObjectStars } from '@/hooks/use-object-stars'
import type { ActorListItem, NotificationResponse, ObjectResponse } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
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

/** Rows shown per group before "Show N more" reveals the rest — the mockup's
 *  own per-group cap (script 6748 `CAP = 40`). */
const LIST_GROUP_ROW_CAP = 40

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
	/** Pending asks keyed by the object they target, threaded from the Objects
	 *  route. The row renders its ask line + pill from the entry for its id. */
	asksByObjectId?: Map<string, NotificationResponse>
	hasNextPage?: boolean
	isFetchingNextPage?: boolean
	isError?: boolean
	error?: Error | null
	fetchNextPage?: () => void
	isLoading?: boolean
	// Controlled group-expansion state (the same contract DataTable exposed).
	// Keyed by react-table's grouped-row id (`<columnId>:<groupValue>`) so the
	// map round-trips with blobs persisted by the DataTable era of this route.
	expanded: Record<string, boolean>
	onExpandedChange: (next: Record<string, boolean>) => void
	// Fires synchronously right before a row-open navigate (see DataTable).
	onCaptureViewState?: () => void
	/** Filter-derived empty-state sentence, e.g. "No bets waiting on you in
	 *  Define right now." Falls back to the unfiltered copy when absent. */
	emptyTitle?: string
	/** True while any filter pill is active — swaps the empty state's copy and
	 *  surfaces the `Clear all filters` action (mockup 1021–1022). */
	hasActiveFilters?: boolean
	onClearFilters?: () => void
	/** Resolves a type key to the workspace's singular display name. Passed in
	 *  rather than read from `useWorkspace()` here so the list stays renderable
	 *  outside a workspace provider; rows fall back to the raw key without it. */
	objectTypeLabel?: (type: string) => string
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
		asksByObjectId,
		hasNextPage,
		isFetchingNextPage,
		isError,
		error,
		fetchNextPage,
		isLoading,
		expanded,
		onExpandedChange,
		onCaptureViewState,
		emptyTitle,
		hasActiveFilters,
		onClearFilters,
		objectTypeLabel,
	},
	ref,
) {
	const navigate = useNavigate()
	const scrollRef = useRef<HTMLDivElement>(null)
	const sentinelRef = useRef<HTMLDivElement>(null)
	const groupBy = grouping?.[0]
	const { starredIds, toggleStar } = useObjectStars(workspaceId)

	// Rows the user is blocking float to the top of the pool (mockup fixture
	// 6655's `nyOf`). A stable partition, so within each half the API's own
	// sort order is untouched — and there is no synthetic "Waiting on you"
	// group, which the mockup doesn't have either.
	const rows = useMemo(() => {
		if (!asksByObjectId || asksByObjectId.size === 0) return data
		const waiting: ObjectResponse[] = []
		const rest: ObjectResponse[] = []
		for (const object of data) {
			if (asksByObjectId.get(object.id)?.status === 'pending') waiting.push(object)
			else rest.push(object)
		}
		return waiting.length === 0 ? data : [...waiting, ...rest]
	}, [data, asksByObjectId])

	// Groups preserve first-occurrence order across the API-sorted data, so the
	// visible order follows the sort/order the shared filter model emitted.
	const groups = useMemo<ListGroup[] | null>(() => {
		if (!groupBy) return null
		const byValue = new Map<string, ListGroup>()
		const order: ListGroup[] = []
		for (const object of rows) {
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
	}, [rows, groupBy])

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
				? rows.filter((o) => getObjectGroupValue(o, groupBy) === groupId).map((o) => o.id)
				: rows.map((o) => o.id)
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
		[groupBy, rows, rowSelection, selectedIdSet, setSelected, onRowSelectionChange],
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
			const open = expanded[group.key] !== false
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
						if (expandedRef.current[groupKey] === false) {
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
	// isFetchingNextPage / isError so a failure doesn't retry-loop. `isEmpty` is
	// a dep because the empty branch renders its own sentinel node: without it
	// the observer would keep watching the unmounted one and stall paging.
	const isEmpty = data.length === 0
	// biome-ignore lint/correctness/useExhaustiveDependencies: `isEmpty` re-arms the observer when the empty branch swaps in its own sentinel node
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
	}, [hasNextPage, isFetchingNextPage, isError, fetchNextPage, isEmpty])

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
				ask={asksByObjectId?.get(object.id)}
				columnVisibility={columnVisibility}
				anySelected={selectedIdSet.size > 0}
				typeLabel={objectTypeLabel?.(object.type)}
				isStarred={starredIds.has(object.id)}
				onToggleStar={toggleStar}
			/>
		))

	if (isLoading) {
		return <ListSkeleton />
	}

	if (isError && data.length === 0) {
		return (
			<QueryStateError
				title="Couldn't load objects"
				error={error instanceof Error ? error : new Error('Unknown error')}
			/>
		)
	}

	if (data.length === 0) {
		// The sentinel stays mounted even with nothing to show. Client-side
		// narrowing (the Attention axis) can empty the loaded pages while
		// matches remain unloaded — dropping the sentinel here would stop the
		// infinite query dead and report "none" over a partial fetch.
		return (
			<div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-auto', 'touch-pan-y')}>
				{hasActiveFilters ? (
					<EmptyState
						title={emptyTitle ?? 'No objects match these filters.'}
						action={
							onClearFilters ? (
								<Button variant="outline" size="sm" onClick={onClearFilters}>
									Clear all filters
								</Button>
							) : undefined
						}
					/>
				) : (
					<EmptyState
						title={emptyTitle ?? 'No objects found'}
						description="Create your first object to get started"
					/>
				)}
				<div ref={sentinelRef} className="h-1" />
				{isFetchingNextPage && (
					<div className="py-2">
						<ListSkeleton rows={2} />
					</div>
				)}
			</div>
		)
	}

	return (
		<div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-auto', 'touch-pan-y')}>
			<ul className="m-0 list-none p-0" aria-label="Objects">
				{groups === null
					? renderRows(rows)
					: groups.map((group) => {
							// Groups render open (mockup 995 `g.open` defaults true) — the
							// expanded map only ever records an explicit collapse.
							const open = expanded[group.key] !== false
							const capped = revealedGroups.has(group.key)
								? group.rows
								: group.rows.slice(0, LIST_GROUP_ROW_CAP)
							const hiddenCount = group.rows.length - LIST_GROUP_ROW_CAP
							return (
								<li key={group.key}>
									{/* Sticky so the group a row belongs to stays readable while
									    its rows scroll past (mockup 995). */}
									<div className="sticky top-0 z-[2] flex w-full items-center gap-2 bg-background px-1 pt-4 pb-1.5">
										<button
											type="button"
											onClick={() => toggleGroup(group)}
											aria-expanded={open}
											className="flex flex-1 items-center gap-2 text-left transition-opacity hover:opacity-75"
										>
											<ChevronRight
												size={12}
												aria-hidden="true"
												className={cn(
													'shrink-0 text-muted-foreground/50 transition-transform',
													open && 'rotate-90',
												)}
											/>
											{/* Mono, wide-tracked and colourless — the divider rule below
											    carries the eye across the row, so the label doesn't also need
											    a status swatch to mark where a group starts (mockup 748–752). */}
											<span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
												{getObjectGroupLabel(groupBy, group.value, actors)}
											</span>
											<span className="font-mono text-[10.5px] font-medium tabular-nums text-muted-foreground/50">
												{group.rows.length}
											</span>
											{/* The hairline runs from the count to the right edge — a long
											    scroll then always has a horizontal rule to break on. */}
											<span aria-hidden="true" className="h-px flex-1 bg-muted" />
										</button>
									</div>
									{open && (
										<>
											{renderRows(capped)}
											{hiddenCount > 0 && !revealedGroups.has(group.key) && (
												<button
													type="button"
													onClick={() => revealGroup(group.key)}
													className="ml-[30px] flex w-fit items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
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
				<div className="py-2">
					<ListSkeleton rows={2} />
				</div>
			)}
		</div>
	)
})
