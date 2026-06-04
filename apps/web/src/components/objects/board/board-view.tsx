import { EmptyState } from '@/components/shared/empty-state'
import { StatusBadge } from '@/components/shared/status-badge'
import { useBulkUpdateObjects } from '@/hooks/use-objects'
import type { ActorListItem, BulkUpdateObjectsInput, ObjectResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	type CollisionDetection,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	DragOverlay,
	PointerSensor,
	closestCenter,
	pointerWithin,
	useDroppable,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
	type PointerEvent,
	type MouseEvent as ReactMouseEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { toast } from 'sonner'
import { BoardCard } from './board-card'
import { deriveColumns } from './derive-columns'

interface BoardViewProps {
	objectType: string
	objects: ObjectResponse[]
	statusesByType: Record<string, string[] | undefined>
	workspaceId: string
	actors?: ActorListItem[]
	isLoading?: boolean
	selectedIds?: string[]
	onObjectSelectionChange?: (id: string, selected: boolean) => void
	onObjectRangeSelectionChange?: (ids: string[]) => void
}

const SKELETON_CARDS_PER_COLUMN = 2
const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE = 8
type PendingBoardPatch = Pick<BulkUpdateObjectsInput['patch'], 'status' | 'metadata'>
interface DragPreview {
	status: string
	insertIndex: number
}

const pointerFirstCollisionDetection: CollisionDetection = (args) => {
	const pointerCollisions = pointerWithin(args)
	return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args)
}

function humanizeStatus(status: string) {
	return status.replace(/_/g, ' ')
}

function getBoardOrder(object: ObjectResponse) {
	const meta = object.metadata && typeof object.metadata === 'object' ? object.metadata : null
	const raw = meta ? (meta as Record<string, unknown>).board_order : null
	return typeof raw === 'number' && Number.isFinite(raw) ? raw : Number.POSITIVE_INFINITY
}

function compareDefaultCardOrder(a: ObjectResponse, b: ObjectResponse) {
	return (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id)
}

function getOrderedObjects(objects: ObjectResponse[]) {
	const fallbackIndexById = new Map<string, number>()
	for (const [index, object] of objects.slice().sort(compareDefaultCardOrder).entries()) {
		fallbackIndexById.set(object.id, index)
	}

	return objects.slice().sort((a, b) => {
		const aOrder = getBoardOrder(a)
		const bOrder = getBoardOrder(b)
		const aEffectiveOrder = Number.isFinite(aOrder) ? aOrder : (fallbackIndexById.get(a.id) ?? 0)
		const bEffectiveOrder = Number.isFinite(bOrder) ? bOrder : (fallbackIndexById.get(b.id) ?? 0)
		const diff = aEffectiveOrder - bEffectiveOrder
		if (diff !== 0) return diff
		return compareDefaultCardOrder(a, b)
	})
}

function getEffectiveBoardOrder(objects: ObjectResponse[], index: number) {
	const object = objects[index]
	if (!object) return null
	const order = getBoardOrder(object)
	return Number.isFinite(order) ? order : index
}

function getPointerY(event: Pick<DragEndEvent, 'activatorEvent' | 'delta'>) {
	const activatorEvent = event.activatorEvent
	const isTouchEvent = typeof TouchEvent !== 'undefined' && activatorEvent instanceof TouchEvent
	if (isTouchEvent) {
		const startY = activatorEvent.touches[0]?.clientY
		return typeof startY === 'number' ? startY + event.delta.y : null
	}

	if (activatorEvent && 'clientY' in activatorEvent) {
		const startY = activatorEvent.clientY
		return typeof startY === 'number' ? startY + event.delta.y : null
	}

	return null
}

function getDropIndex({
	active,
	over,
	targetObjects,
	draggedId,
	pointerY,
}: {
	active: DragEndEvent['active']
	over: NonNullable<DragEndEvent['over']>
	targetObjects: ObjectResponse[]
	draggedId: string
	pointerY: number | null
}) {
	const overId = String(over.id)
	const overObject = targetObjects.find((obj) => obj.id === overId)
	if (!overObject) return targetObjects.length

	const overIndex = targetObjects.findIndex((obj) => obj.id === overObject.id)
	if (overIndex < 0) return targetObjects.length

	const activeRect = active.rect.current.translated ?? active.rect.current.initial
	const overRect = over.rect
	if (!overRect) return overIndex

	const activeCenterY = activeRect ? activeRect.top + activeRect.height / 2 : null
	const dragReferenceY = pointerY ?? activeCenterY
	if (dragReferenceY === null) return overIndex
	const overMiddleY = overRect.top + overRect.height / 2
	const insertAfter = dragReferenceY > overMiddleY
	const insertIndex = overIndex + (insertAfter ? 1 : 0)

	// Guard against the dragged card being the same card that was hovered.
	if (overObject.id === draggedId) return overIndex

	return Math.min(insertIndex, targetObjects.length)
}

export function BoardView({
	objectType,
	objects,
	statusesByType,
	workspaceId,
	actors,
	isLoading,
	selectedIds = [],
	onObjectSelectionChange,
	onObjectRangeSelectionChange,
}: BoardViewProps) {
	const bulkUpdate = useBulkUpdateObjects(workspaceId)
	const [activeObject, setActiveObject] = useState<ObjectResponse | null>(null)
	const [overStatus, setOverStatus] = useState<string | null>(null)
	const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
	const [pendingPatches, setPendingPatches] = useState<Record<string, PendingBoardPatch>>({})
	const [selectionAnchorByStatus, setSelectionAnchorByStatus] = useState<Record<string, string>>({})

	const displayObjects = useMemo(
		() =>
			objects.map((object) => {
				const pending = pendingPatches[object.id]
				if (!pending) return object
				return {
					...object,
					...(pending.status ? { status: pending.status } : {}),
					...(pending.metadata
						? { metadata: { ...(object.metadata ?? {}), ...pending.metadata } }
						: {}),
				}
			}),
		[objects, pendingPatches],
	)
	const columns = deriveColumns(objectType, statusesByType, displayObjects)
	const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])

	const selectSingleCard = (status: string, id: string, selected: boolean) => {
		onObjectSelectionChange?.(id, selected)
		setSelectionAnchorByStatus((current) => ({ ...current, [status]: id }))
	}

	const selectCardRange = (status: string, orderedIds: string[], id: string) => {
		const anchorId = selectionAnchorByStatus[status]
		if (selectedIds.length === 0 || !anchorId || !selectedIdSet.has(anchorId)) {
			selectSingleCard(status, id, true)
			return
		}

		const anchorIndex = orderedIds.indexOf(anchorId)
		const targetIndex = orderedIds.indexOf(id)
		if (anchorIndex < 0 || targetIndex < 0) {
			selectSingleCard(status, id, true)
			return
		}

		const start = Math.min(anchorIndex, targetIndex)
		const end = Math.max(anchorIndex, targetIndex)
		onObjectRangeSelectionChange?.(orderedIds.slice(start, end + 1))
	}

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

	useEffect(() => {
		setPendingPatches((current) => {
			const next = { ...current }
			let changed = false

			for (const [id, pending] of Object.entries(current)) {
				const object = objects.find((obj) => obj.id === id)
				if (!object) continue

				const statusMatches = pending.status === undefined || object.status === pending.status
				const metadataMatches = Object.entries(pending.metadata ?? {}).every(([key, value]) => {
					const metadata = object.metadata as Record<string, unknown> | null
					return metadata?.[key] === value
				})

				if (statusMatches && metadataMatches) {
					delete next[id]
					changed = true
				}
			}

			return changed ? next : current
		})
	}, [objects])

	if (columns.length === 0) {
		return (
			<EmptyState
				title="No statuses configured"
				description={`Add statuses for "${objectType}" in workspace settings to use the board view.`}
			/>
		)
	}

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		setActiveObject(null)
		setOverStatus(null)
		setDragPreview(null)
		if (!over) return
		const dragged = active.data.current?.object as ObjectResponse | undefined
		const toStatus = over.data.current?.status as string | undefined
		if (!dragged || !toStatus) return
		const overObject = columns
			.flatMap((column) => column.objects)
			.find((object) => object.id === String(over.id))
		const sameSpot = dragged.id === overObject?.id
		const statusChanged = dragged.status !== toStatus
		if (!statusChanged && sameSpot) return
		if (!statusChanged && !overObject) return

		const targetColumn = columns.find((column) => column.status === toStatus)
		if (!targetColumn) return

		const targetObjects = getOrderedObjects(
			targetColumn.objects.filter((obj) => obj.id !== dragged.id),
		)
		const pointerY = getPointerY(event)
		const insertIndex = overObject
			? getDropIndex({
					active,
					over,
					targetObjects,
					draggedId: dragged.id,
					pointerY,
				})
			: dragPreview?.status === toStatus
				? dragPreview.insertIndex
				: targetObjects.length

		const prevOrder =
			insertIndex > 0 ? getEffectiveBoardOrder(targetObjects, insertIndex - 1) : null
		const nextOrder =
			insertIndex < targetObjects.length ? getEffectiveBoardOrder(targetObjects, insertIndex) : null

		let nextBoardOrder: number
		if (prevOrder === null && nextOrder === null) nextBoardOrder = 0
		else if (prevOrder === null) nextBoardOrder = (nextOrder ?? 1) - 1
		else if (nextOrder === null) nextBoardOrder = prevOrder + 1
		else nextBoardOrder = prevOrder + (nextOrder - prevOrder) / 2

		const nextMetadata: NonNullable<BulkUpdateObjectsInput['patch']['metadata']> = {
			...(dragged.metadata ?? {}),
			board_order: nextBoardOrder,
		}
		const pendingPatch: PendingBoardPatch = {
			...(statusChanged ? { status: toStatus } : {}),
			metadata: nextMetadata,
		}

		setPendingPatches((current) => ({
			...current,
			[dragged.id]: pendingPatch,
		}))

		const removePendingPatch = () => {
			setPendingPatches((current) => {
				const { [dragged.id]: _removed, ...rest } = current
				return rest
			})
		}

		bulkUpdate.mutate(
			{
				ids: [dragged.id],
				patch: pendingPatch,
			},
			{
				onSuccess: (data) => {
					const result = data.results.find((item) => item.id === dragged.id)
					if (result?.ok === false) {
						removePendingPatch()
						toast.error(result.error ?? 'Could not move card')
					}
				},
				onError: (err) => {
					removePendingPatch()
					toast.error(err instanceof Error ? err.message : 'Could not move card')
				},
			},
		)
	}

	return (
		<DndContext
			collisionDetection={pointerFirstCollisionDetection}
			sensors={sensors}
			onDragStart={({ active }) => {
				const object = active.data.current?.object as ObjectResponse | undefined
				setActiveObject(object ?? null)
			}}
			onDragOver={(event: DragOverEvent) => {
				const { active, over } = event
				setOverStatus((over?.data.current?.status as string | undefined) ?? null)
				const dragged = active.data.current?.object as ObjectResponse | undefined
				const toStatus = over?.data.current?.status as string | undefined
				if (!dragged || !toStatus || dragged.status === toStatus || !over) {
					setDragPreview(null)
					return
				}

				const targetColumn = columns.find((column) => column.status === toStatus)
				if (!targetColumn) {
					setDragPreview(null)
					return
				}

				const targetObjects = getOrderedObjects(
					targetColumn.objects.filter((obj) => obj.id !== dragged.id),
				)
				const overObject = targetObjects.find((object) => object.id === String(over.id))
				if (!overObject && targetObjects.length > 0) {
					setDragPreview((current) =>
						current?.status === toStatus
							? current
							: { status: toStatus, insertIndex: targetObjects.length },
					)
					return
				}

				const insertIndex = overObject
					? getDropIndex({
							active,
							over,
							targetObjects,
							draggedId: dragged.id,
							pointerY: getPointerY(event),
						})
					: targetObjects.length
				setDragPreview({ status: toStatus, insertIndex })
			}}
			onDragCancel={() => {
				setActiveObject(null)
				setDragPreview(null)
			}}
			onDragEnd={handleDragEnd}
		>
			<div
				data-testid="board-view"
				className={cn('flex gap-3 overflow-x-auto pb-2', activeObject && 'cursor-grabbing')}
			>
				{columns.map((column) => (
					<BoardColumn
						key={column.status}
						status={column.status}
						objects={column.objects}
						workspaceId={workspaceId}
						actors={actors}
						isLoading={isLoading}
						isOverTarget={overStatus === column.status && activeObject?.status !== column.status}
						previewObject={
							dragPreview?.status === column.status && activeObject
								? { ...activeObject, status: column.status }
								: null
						}
						previewIndex={dragPreview?.status === column.status ? dragPreview.insertIndex : null}
						selectedIds={selectedIdSet}
						onObjectSelectionChange={selectSingleCard}
						onObjectRangeSelectionChange={selectCardRange}
					/>
				))}
			</div>
			<DragOverlay dropAnimation={null}>
				{activeObject ? (
					<div className="pointer-events-none cursor-grabbing rotate-2 scale-[1.02] shadow-lg">
						<BoardCard object={activeObject} workspaceId={workspaceId} actors={actors} />
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	)
}

interface BoardColumnProps {
	status: string
	objects: ObjectResponse[]
	workspaceId: string
	actors?: ActorListItem[]
	isLoading?: boolean
	isOverTarget?: boolean
	previewObject?: ObjectResponse | null
	previewIndex?: number | null
	selectedIds: Set<string>
	onObjectSelectionChange?: (status: string, id: string, selected: boolean) => void
	onObjectRangeSelectionChange?: (status: string, orderedIds: string[], id: string) => void
}

function BoardColumn({
	status,
	objects,
	workspaceId,
	actors,
	isLoading,
	isOverTarget,
	previewObject,
	previewIndex,
	selectedIds,
	onObjectSelectionChange,
	onObjectRangeSelectionChange,
}: BoardColumnProps) {
	const { setNodeRef, isOver, active } = useDroppable({
		id: `col:${status}`,
		data: { status },
	})

	const activeObject = active?.data.current?.object as ObjectResponse | undefined
	const isValidTarget = Boolean(
		(isOverTarget ?? isOver) && activeObject && activeObject.status !== status,
	)
	const orderedObjects = getOrderedObjects(objects)
	const orderedIds = useMemo(() => orderedObjects.map((object) => object.id), [orderedObjects])
	const previewCard = previewObject ? (
		<DropPreview object={previewObject} workspaceId={workspaceId} actors={actors} />
	) : null

	return (
		<div
			ref={setNodeRef}
			data-testid={`board-column-${status}`}
			className={cn(
				'relative flex min-h-[28rem] shrink-0 flex-col gap-2 rounded-md transition-colors',
				'w-full sm:w-72 md:w-72 lg:w-80',
				isValidTarget && 'bg-accent/5',
			)}
		>
			<div className="flex items-center justify-between px-1">
				<StatusBadge status={status} />
				<span className="text-xs text-muted-foreground tabular-nums">{objects.length}</span>
			</div>

			<div
				className={cn(
					'relative flex min-h-24 flex-col gap-2 rounded-md transition-colors',
					isValidTarget &&
						'border border-dashed border-border/70 bg-accent/10 ring-1 ring-accent/15',
				)}
			>
				{isLoading ? (
					<div className="flex flex-col gap-2">
						{Array.from({ length: SKELETON_CARDS_PER_COLUMN }).map((_, i) => (
							<CardSkeleton
								// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows never reorder
								key={`skeleton-${i}`}
							/>
						))}
					</div>
				) : orderedObjects.length === 0 ? (
					previewCard ? (
						previewCard
					) : isValidTarget ? (
						<div className="pointer-events-none min-h-14 rounded-md border border-dashed border-border/70 bg-accent/20 px-3 py-3 text-xs text-muted-foreground">
							Drop here to move to {humanizeStatus(status)}.
						</div>
					) : (
						<ColumnEmpty status={status} />
					)
				) : (
					<SortableContext
						items={orderedObjects.map((obj) => obj.id)}
						strategy={verticalListSortingStrategy}
					>
						<div className="flex flex-col gap-2">
							{orderedObjects.map((obj, index) => (
								<div key={obj.id} className="contents">
									{previewIndex === index && previewCard}
									<DraggableBoardCard
										object={obj}
										workspaceId={workspaceId}
										actors={actors}
										isSelected={selectedIds.has(obj.id)}
										status={status}
										orderedIds={orderedIds}
										onSelectionChange={onObjectSelectionChange}
										onRangeSelectionChange={onObjectRangeSelectionChange}
									/>
								</div>
							))}
							{previewIndex === orderedObjects.length && previewCard}
						</div>
					</SortableContext>
				)}
				{isValidTarget && orderedObjects.length > 0 && previewIndex === null && (
					<div className="pointer-events-none min-h-14 rounded-md border border-dashed border-border/70 bg-accent/20 px-3 py-3 text-xs text-muted-foreground">
						Drop here to move to {humanizeStatus(status)}.
					</div>
				)}
			</div>
		</div>
	)
}

function DropPreview({
	object,
	workspaceId,
	actors,
}: {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
}) {
	return (
		<div
			data-testid="board-drop-preview"
			aria-hidden="true"
			className="pointer-events-none opacity-40"
		>
			<BoardCard object={object} workspaceId={workspaceId} actors={actors} />
		</div>
	)
}

interface DraggableBoardCardProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected?: boolean
	status: string
	orderedIds: string[]
	onSelectionChange?: (status: string, id: string, selected: boolean) => void
	onRangeSelectionChange?: (status: string, orderedIds: string[], id: string) => void
}

function DraggableBoardCard({
	object,
	workspaceId,
	actors,
	isSelected,
	status,
	orderedIds,
	onSelectionChange,
	onRangeSelectionChange,
}: DraggableBoardCardProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: object.id,
		data: { object, status: object.status },
	})
	const longPressTimerRef = useRef<number | null>(null)
	const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
	const suppressNextClickRef = useRef(false)
	const suppressNextContextMenuRef = useRef(false)

	const clearLongPress = () => {
		if (longPressTimerRef.current) {
			window.clearTimeout(longPressTimerRef.current)
			longPressTimerRef.current = null
		}
		longPressStartRef.current = null
	}

	const toggleSelection = () => {
		onSelectionChange?.(status, object.id, !isSelected)
	}

	const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
		const sortablePointerDown = listeners?.onPointerDown as
			| ((event: PointerEvent<HTMLDivElement>) => void)
			| undefined
		sortablePointerDown?.(event)
		if (!onSelectionChange || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return
		longPressStartRef.current = { x: event.clientX, y: event.clientY }
		longPressTimerRef.current = window.setTimeout(() => {
			suppressNextClickRef.current = true
			suppressNextContextMenuRef.current = true
			toggleSelection()
			clearLongPress()
		}, LONG_PRESS_MS)
	}

	const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const start = longPressStartRef.current
		if (!start) return
		const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
		if (moved > LONG_PRESS_MOVE_TOLERANCE) clearLongPress()
	}

	const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (suppressNextClickRef.current) {
			suppressNextClickRef.current = false
			event.preventDefault()
			event.stopPropagation()
			return
		}
		if (event.shiftKey && onRangeSelectionChange) {
			event.preventDefault()
			event.stopPropagation()
			onRangeSelectionChange(status, orderedIds, object.id)
		}
	}

	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			data-testid="board-card-draggable"
			data-state={isSelected ? 'selected' : undefined}
			onContextMenu={(event) => {
				event.preventDefault()
				if (suppressNextContextMenuRef.current) {
					suppressNextContextMenuRef.current = false
					event.stopPropagation()
					return
				}
				if (!onSelectionChange) return
				toggleSelection()
			}}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={clearLongPress}
			onPointerCancel={clearLongPress}
			onPointerLeave={clearLongPress}
			onClickCapture={handleClickCapture}
			className={cn(
				'touch-none select-none cursor-grab active:cursor-grabbing',
				isDragging && 'cursor-grabbing opacity-40',
			)}
			style={{
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX ?? 1}) scaleY(${transform.scaleY ?? 1})`
					: undefined,
				transition,
			}}
		>
			<BoardCard
				object={object}
				workspaceId={workspaceId}
				actors={actors}
				isSelected={isSelected}
			/>
		</div>
	)
}

function CardSkeleton() {
	return (
		<div
			data-testid="board-card-skeleton"
			className="h-16 animate-pulse rounded-md border border-border bg-card"
		/>
	)
}

function ColumnEmpty({ status }: { status: string }) {
	return (
		<div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
			<p>Nothing here yet.</p>
			<p className="mt-1">Drag a card to {humanizeStatus(status)}.</p>
		</div>
	)
}
