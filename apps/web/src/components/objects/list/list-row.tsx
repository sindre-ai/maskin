import { ActorAvatar } from '@/components/shared/actor-avatar'
import { AgentWorkingBadge } from '@/components/shared/agent-working-badge'
import { IndicatorBadgeRow } from '@/components/shared/indicator-badge'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { TypeBadge } from '@/components/shared/type-badge'
import { Checkbox } from '@/components/ui/checkbox'
import type { ActorListItem, NotificationResponse, ObjectResponse } from '@/lib/api'
import type { BetStatusResult } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
import { getTypeColor } from '@/lib/constants'
import { Link } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'
import { ChevronRight } from 'lucide-react'

export interface ListRowProps {
	object: ObjectResponse
	workspaceId: string
	actors?: ActorListItem[]
	isSelected: boolean
	onSelect: (selected: boolean) => void
	/** Row-open navigation — identical to the DataTable row-click contract: the
	 *  list calls its own capture-then-navigate at view level, so shift-clickers
	 *  never lose their selection to a navigate. */
	onOpen: (objectId: string) => void
	/** Fired on shift-click so the view can extend the selection to a range. */
	onShiftClick: (objectId: string) => void
	/** The workspace's pending needs_input ask targeting this row, if any. The
	 *  row shows the ask line + "Waiting on you" pill only while the ask is
	 *  still pending — a resolved/dismissed ask never renders. */
	ask?: NotificationResponse
	betStatus?: BetStatusResult
	showBetStatusIndicator?: boolean
	columnVisibility: VisibilityState
	/** True once any row in the list is selected. Flips the whole list from the
	 *  resting type-dot affordance to an explicit checkbox column (mockup 1002–1006). */
	anySelected?: boolean
}

export function ListRow({
	object,
	workspaceId,
	actors,
	isSelected,
	onSelect,
	onOpen,
	onShiftClick,
	ask,
	betStatus,
	showBetStatusIndicator,
	columnVisibility,
	anySelected,
}: ListRowProps) {
	const driver = object.driver ? actors?.find((a) => a.id === object.driver) : null
	const isArchived = object.status === 'archived'
	// Prior status is populated by the archive handler (T6) into metadata.previous_status.
	// We only render "was <status>" when it's set; falling back to `object.status` would
	// print "was archived", which is useless.
	const priorStatusRaw = object.metadata?.previous_status
	const priorStatus = isArchived && typeof priorStatusRaw === 'string' ? priorStatusRaw : null
	const hasPendingAsk = ask?.status === 'pending'
	const askActorName = hasPendingAsk
		? (actors?.find((a) => a.id === ask.sourceActorId)?.name ?? 'Agent')
		: null
	const showType = columnVisibility.type !== false
	const showTag = columnVisibility.status !== false
	const showDriver = columnVisibility.driver !== false
	const showUpdated = columnVisibility.updatedAt !== false
	// At rest the 20px slot carries the object's type dot; it becomes a checkbox
	// on hover, and every row switches to a checkbox once anything is selected.
	const showRestingDot = !anySelected && !isSelected
	const typeDot = getTypeColor(object.type)

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the row carries a real Link for keyboard navigation; click supplements it (same pattern as ObjectCard).
		<div
			data-obj-id={object.id}
			data-state={isSelected ? 'selected' : undefined}
			data-archived={isArchived ? '' : undefined}
			onClick={(e) => {
				if (e.shiftKey) {
					e.preventDefault()
					e.stopPropagation()
					onShiftClick(object.id)
					return
				}
				onOpen(object.id)
			}}
			className={cn(
				'group flex w-full items-center gap-3 rounded-lg px-3 py-2.5',
				'cursor-pointer transition-colors hover:bg-muted/40',
				'data-[state=selected]:bg-muted',
				isArchived && 'opacity-[0.62] hover:opacity-90',
			)}
		>
			<span className="relative grid size-5 shrink-0 place-items-center self-center">
				{showRestingDot && (
					<span
						aria-hidden="true"
						className={cn(
							// Touch viewports have no hover, so the checkbox is always
							// visible there and the dot always yields to it. `pointer-coarse`
							// carries iPad landscape, which sits at the `lg` breakpoint but
							// still has no hover.
							'pointer-events-none absolute size-2 rounded-[2px] bg-current transition-opacity',
							'group-hover:opacity-0 max-lg:opacity-0 pointer-coarse:opacity-0',
							typeDot.text,
						)}
					/>
				)}
				<Checkbox
					size="touch"
					checked={isSelected}
					onCheckedChange={(value) => onSelect(!!value)}
					onClick={(e) => e.stopPropagation()}
					aria-label="Select row"
					className={cn(
						'shrink-0 touch-none select-none transition-opacity',
						// Hidden-but-present at rest so the 44px tap target survives on
						// touch, where there is no hover to reveal it.
						showRestingDot &&
							'opacity-0 group-hover:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100',
					)}
				/>
			</span>
			{showType && (
				<TypeBadge type={object.type} variant="mono" className="w-14 flex-none truncate" />
			)}
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: object.id }}
						onClick={(e) => {
							if (e.shiftKey) {
								e.preventDefault()
								e.stopPropagation()
								onShiftClick(object.id)
								return
							}
							if (e.metaKey || e.ctrlKey || e.button === 1) {
								// Let the browser open the link in a new tab — just stop the
								// row's own onClick from also navigating the current tab.
								e.stopPropagation()
								return
							}
							// Route a plain click through the same capture-then-navigate path
							// as the rest of the row (see ListView.handleOpen) instead of the
							// Link's own navigation — otherwise clicking the title (the widest
							// hit target on narrow viewports) skips onCaptureViewState and the
							// scroll-anchor view-state snapshot never gets taken.
							e.preventDefault()
							e.stopPropagation()
							onOpen(object.id)
						}}
						className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
					>
						{object.title || 'Untitled'}
					</Link>
					{hasPendingAsk && (
						<span className="shrink-0 rounded-full border border-ask-border bg-ask-surface px-2 py-0.5 text-[10px] font-bold leading-none text-warning">
							Waiting on you
						</span>
					)}
					{betStatus && showBetStatusIndicator && (
						<IndicatorBadgeRow result={betStatus} className="shrink-0" />
					)}
					{object.activeSessionId && (
						<AgentWorkingBadge sessionId={object.activeSessionId} workspaceId={workspaceId} />
					)}
				</div>
				{hasPendingAsk && (
					// The type label is a sibling column here (not inline with the
					// title as in the mockup), so the ask line already starts at the
					// title column — no extra `askIndent` offset is needed.
					<p className="truncate text-xs leading-snug text-muted-foreground">
						<span className="font-bold text-warning">{askActorName} asks</span>{' '}
						{ask.content ?? ask.title}
					</p>
				)}
				{priorStatus && (
					<p className="truncate text-xs leading-snug text-muted-foreground">
						was {priorStatus.replace(/_/g, ' ')}
					</p>
				)}
			</div>
			{showTag && <StatusBadge status={object.status} variant="dot-word" className="shrink-0" />}
			{showDriver && driver && (
				<ActorAvatar id={driver.id} name={driver.name} type={driver.type} className="shrink-0" />
			)}
			{showUpdated && object.updatedAt && (
				<RelativeTime
					date={object.updatedAt}
					compact
					// Mockup 764: a 30px right-aligned age column. `min-w` rather than a
					// hard width, and nowrap, so a day/month token ("Jan 15") widens
					// the column instead of wrapping onto a second line.
					className="min-w-8 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground"
				/>
			)}
			<button
				type="button"
				aria-label="Open object"
				onClick={(e) => {
					e.stopPropagation()
					onOpen(object.id)
				}}
				className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
			>
				<ChevronRight size={15} aria-hidden="true" />
			</button>
		</div>
	)
}
