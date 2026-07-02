import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import type { BetStatusResult, BetStatusState } from '@/lib/bet-status'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import { useCallback, useState } from 'react'

const STATE_LABEL: Record<BetStatusState, string> = {
	waiting_on_human: 'waiting',
	progressing: 'progressing',
	stalled: 'stalled',
	idle: 'idle',
}

const CHIP_LABEL: Record<BetStatusState, string> = {
	waiting_on_human: 'waiting on human',
	progressing: 'progressing',
	stalled: 'stalled',
	idle: 'idle',
}

const DOT_COLOR: Record<BetStatusState, string> = {
	waiting_on_human: 'bg-error',
	progressing: 'bg-success animate-pulse',
	stalled: 'bg-warning',
	idle: 'bg-muted-foreground opacity-70',
}

const ROW_TEXT: Record<BetStatusState, string> = {
	waiting_on_human: 'text-status-blocked-text font-semibold',
	progressing: 'text-status-active-text',
	stalled: 'text-status-in_review-text',
	idle: 'text-muted-foreground',
}

const CHIP_BG: Record<BetStatusState, string> = {
	waiting_on_human: 'bg-status-blocked-bg text-status-blocked-text',
	progressing: 'bg-status-active-bg text-status-active-text',
	stalled: 'bg-status-in_review-bg text-status-in_review-text',
	idle: 'bg-transparent text-muted-foreground',
}

// Row variant — dot + lowercase word. Used inline in the objects-overview Title cell.
// No background; `waiting` is louder (semibold + red halo on the dot).
export function IndicatorBadgeRow({
	result,
	className,
}: {
	result: BetStatusResult
	className?: string
}) {
	const state = result.state
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 text-xs leading-none',
				ROW_TEXT[state],
				className,
			)}
			aria-label={`Status: ${STATE_LABEL[state]}`}
		>
			<span
				aria-hidden="true"
				className={cn(
					'inline-block h-2 w-2 shrink-0 rounded-full',
					DOT_COLOR[state],
					state === 'waiting_on_human' && 'ring-2 ring-error/25',
				)}
			/>
			{STATE_LABEL[state]}
		</span>
	)
}

// Chip variant — pill trigger + popover. Used in the bet detail header
// provenance row. Opens on hover (desktop), click (mobile), and keyboard.
export function IndicatorBadgeChip({
	result,
	workspaceId,
	className,
}: {
	result: BetStatusResult
	workspaceId: string
	className?: string
}) {
	const [open, setOpen] = useState(false)
	const state = result.state
	const label = CHIP_LABEL[state]

	const handleMouseEnter = useCallback(() => setOpen(true), [])
	const handleMouseLeave = useCallback(() => setOpen(false), [])
	const handleClick = useCallback(() => setOpen((prev) => !prev), [])

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverAnchor asChild>
				<button
					type="button"
					className={cn(
						'inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium leading-none transition-colors',
						'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
						CHIP_BG[state],
						className,
					)}
					aria-label={`Status: ${label}`}
					aria-expanded={open}
					aria-haspopup="dialog"
					onClick={handleClick}
					onMouseEnter={handleMouseEnter}
					onMouseLeave={handleMouseLeave}
					onKeyDown={(e) => {
						if (e.key === 'Escape' && open) {
							e.stopPropagation()
							setOpen(false)
						}
					}}
				>
					<span
						aria-hidden="true"
						className={cn(
							'inline-block h-2 w-2 shrink-0 rounded-full',
							DOT_COLOR[state],
							state === 'waiting_on_human' && 'ring-2 ring-error/25',
						)}
					/>
					{label}
				</button>
			</PopoverAnchor>
			<PopoverContent
				align="start"
				sideOffset={6}
				className="w-80 p-3.5"
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<IndicatorPopoverBody result={result} workspaceId={workspaceId} />
			</PopoverContent>
		</Popover>
	)
}

const HEADER_LABEL: Record<BetStatusState, string> = {
	waiting_on_human: 'Waiting on human',
	progressing: 'Progressing',
	stalled: 'Stalled',
	idle: 'Idle',
}

function IndicatorPopoverBody({
	result,
	workspaceId,
}: {
	result: BetStatusResult
	workspaceId: string
}) {
	const { state, pendingAction, decisionsSoFar } = result
	const firstPending = pendingAction?.tasks[0]
	const headerTitle =
		state === 'waiting_on_human' && firstPending?.title
			? `Waiting: ${firstPending.title}`
			: HEADER_LABEL[state]

	if (state === 'idle' && decisionsSoFar.length === 0 && !pendingAction) {
		return (
			<div>
				<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
					Idle
				</div>
				<p className="text-xs text-muted-foreground">
					No open human decisions and no in-flight tasks. Bet is shaped but not being worked.
				</p>
			</div>
		)
	}

	return (
		<div className="space-y-3">
			<div>
				<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">
					{HEADER_LABEL[state]}
				</div>
				<h3 className="text-sm font-semibold leading-snug text-foreground">{headerTitle}</h3>
			</div>

			{decisionsSoFar.length > 0 && (
				<div>
					<div className="text-xs font-medium text-foreground mb-1.5">Decisions so far</div>
					<ul className="space-y-1">
						{decisionsSoFar.slice(0, 5).map((d) => (
							<li key={d.taskId} className="flex items-start gap-2 text-xs text-foreground">
								<span aria-hidden="true" className="text-success font-bold leading-tight">
									✓
								</span>
								<span className="min-w-0 flex-1 break-words">{d.title ?? 'Untitled'}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{pendingAction && firstPending && (
				<div className="border-t border-border pt-3">
					<div className="text-xs font-medium text-foreground mb-1">
						{pendingAction.kind === 'progressing' ? 'In flight' : 'Pending'}
					</div>
					<div className="text-xs text-muted-foreground break-words">{firstPending.title}</div>
					<Link
						to="/$workspaceId/objects/$objectId"
						params={{ workspaceId, objectId: firstPending.id }}
						className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
					>
						→ Open task
					</Link>
					<div className="mt-2 text-[11px] italic text-muted-foreground">
						Read-only — the link deep-links to the task, no action fires from here.
					</div>
				</div>
			)}
		</div>
	)
}
