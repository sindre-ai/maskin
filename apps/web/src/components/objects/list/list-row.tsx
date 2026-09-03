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
import { Link } from '@tanstack/react-router'
import type { VisibilityState } from '@tanstack/react-table'

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
	 *  resting star affordance to an explicit checkbox column (mockup 756–758's
	 *  `showStar: !selectionActive`). */
	anySelected?: boolean
	/** The workspace's display name for this row's type ("Article", "Company").
	 *  Absent for a type the workspace no longer defines, where the raw key is
	 *  the only honest label left. */
	typeLabel?: string
	isStarred?: boolean
	onToggleStar?: (objectId: string) => void
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
	typeLabel,
	isStarred,
	onToggleStar,
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
	// At rest the 20px slot carries the star; every row switches to a checkbox
	// once anything is selected (mockup 756–758). The star has to stay clickable
	// while the pointer is over the row, so — unlike the dot this replaced — it
	// cannot be the thing that yields to the checkbox on hover. The checkbox
	// instead appears in the page gutter to the row's left, which keeps the
	// resting row pixel-identical to the mockup and leaves both affordances
	// hittable at the same time.
	const selectionMode = !!anySelected || isSelected
	const showStar = !selectionMode

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
				'group relative flex w-full items-center gap-3 rounded-lg py-2.5 pr-3',
				// The extra left padding is the select lane: the checkbox is absolutely
				// placed in it so revealing it on hover shifts nothing, and reserving
				// the space keeps it inside the row's own hover highlight instead of
				// hanging off the list's left edge.
				// Touch puts the checkbox back in the star's slot, so the lane is dead
				// space there — hand those pixels back to the title.
				'pl-8 max-[1024.02px]:pl-3 pointer-coarse:pl-3',
				'cursor-pointer transition-colors hover:bg-muted/40',
				'data-[state=selected]:bg-muted',
				isArchived && 'opacity-[0.62] hover:opacity-90',
			)}
		>
			{/* The leading slot is star-sized on pointer devices. On touch the
			    checkbox takes it over at the primitive's mandated 44px (see
			    `Checkbox`'s TOUCH_ROOT), so the slot grows to match — a 44px control
			    centred in a 20px slot would spill over the type plate beside it. */}
			<span className="grid size-5 shrink-0 place-items-center self-center max-[1024.02px]:size-11 pointer-coarse:size-11">
				{showStar && (
					<button
						type="button"
						aria-label={isStarred ? 'Unstar' : 'Star'}
						aria-pressed={isStarred}
						onClick={(e) => {
							e.preventDefault()
							e.stopPropagation()
							onToggleStar?.(object.id)
						}}
						className={cn(
							'text-[13px] leading-none transition-colors',
							// Touch has no hover, so the slot there belongs to the checkbox
							// (see below) and the star stands down. The 1024.02px cutoff is the
							// one `Checkbox` itself uses — Tailwind's `max-lg` is exclusive of
							// 1024, so at exactly iPad-landscape width the checkbox would go
							// touch-sized while the star still held the slot.
							'max-[1024.02px]:hidden pointer-coarse:hidden',
							isStarred ? 'text-foreground' : 'text-border-strong hover:text-muted-foreground',
						)}
					>
						{isStarred ? '★' : '☆'}
					</button>
				)}
				<Checkbox
					size="touch"
					checked={isSelected}
					onCheckedChange={(value) => onSelect(!!value)}
					onClick={(e) => e.stopPropagation()}
					aria-label="Select row"
					className={cn(
						'shrink-0 touch-none select-none',
						// One checkbox per row, in one of two places. In selection mode it
						// sits in the slot; at rest the star has the slot, so the checkbox
						// moves out into the page gutter and fades in on hover — that way
						// both controls stay hittable instead of trading the same 20px.
						// Touch viewports have no hover, so it stays visible there;
						// `pointer-coarse` carries iPad landscape, which sits at the `lg`
						// breakpoint but still has no hover.
						showStar && [
							// Pointer devices: the star owns the slot, so the checkbox waits
							// in the row's select lane and fades in on row hover — both
							// controls stay hittable instead of trading the same 20px.
							'absolute left-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity',
							'group-hover:opacity-100 focus-visible:opacity-100',
							// Touch: no hover to reveal it, and a 44px control in the lane
							// would collide with the type plate. It takes the slot back.
							'max-[1024.02px]:static max-[1024.02px]:translate-y-0 max-[1024.02px]:opacity-100',
							'pointer-coarse:static pointer-coarse:translate-y-0 pointer-coarse:opacity-100',
						],
					)}
				/>
			</span>
			{showType && <TypeBadge type={object.type} label={typeLabel} variant="pill" />}
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
			{/* The mockup's row status is the bare coloured word — no dot, no pill
			    (759). A dot beside it doubles the colour signal in 11px of space. */}
			{showTag && (
				<StatusBadge
					status={object.status}
					variant="word"
					// Hidden below `sm`: at 375px the leading 44px touch checkbox plus
					// five columns leaves the title under 90px, and the status word is
					// the one column the reader can already get from the group header
					// (grouping rests on Status). It returns at 640px.
					className="hidden text-[11px] font-semibold sm:inline"
				/>
			)}
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
		</div>
	)
}
