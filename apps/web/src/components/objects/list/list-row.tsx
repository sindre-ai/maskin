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
				'group flex w-full items-center gap-3 border-b border-border px-4 py-2.5',
				'cursor-pointer transition-colors hover:bg-accent/30',
				'data-[state=selected]:bg-accent/50',
				isArchived && 'opacity-[0.62] hover:opacity-90',
			)}
		>
			<Checkbox
				size="touch"
				checked={isSelected}
				onCheckedChange={(value) => onSelect(!!value)}
				onClick={(e) => e.stopPropagation()}
				aria-label="Select row"
				className="shrink-0 touch-none select-none self-center"
			/>
			{showType && (
				<TypeBadge type={object.type} variant="mono" className="w-14 flex-none truncate" />
			)}
			<div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: object.id }}
						onClick={(e) => e.stopPropagation()}
						className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
					>
						{object.title || 'Untitled'}
					</Link>
					{hasPendingAsk && (
						<span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-foreground">
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
					<p className="truncate text-xs leading-snug text-muted-foreground">
						{askActorName} asks · {ask.content ?? ask.title}
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
					className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
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
