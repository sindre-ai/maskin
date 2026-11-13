import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { defaultStatusColor, statusColors, statusLabel, statusStage } from '@/lib/constants'

type StatusBadgeVariant = 'default' | 'dot-word' | 'word' | 'ring'

type StatusBadgeProps = {
	status: string
	className?: string
} & (
	| {
			variant: 'ring'
			// The ring is a read-only glyph: it accepts no click handler, so a
			// caller can't ship a control that does nothing.
			onClick?: never
			// Pixel size of the ring (16 in rows, 14 in dense meta).
			size?: number
	  }
	| {
			variant?: Exclude<StatusBadgeVariant, 'ring'>
			onClick?: () => void
			size?: never
	  }
)

export function StatusBadge({
	status,
	onClick,
	className,
	variant = 'default',
	size = 16,
}: StatusBadgeProps) {
	// `defaultStatusColor` rather than a literal: statuses are workspace-
	// configurable, and the old fallback was light text sized for a dark pill.
	// The `word` and `dot-word` variants drop the pill and render `text` on the
	// surface itself, where `text-zinc-300` is unreadable in light mode.
	const colors = statusColors[status] ?? defaultStatusColor
	const label = status.replace(/_/g, ' ')

	// The v3 row and group-header status: a small ring that fills as the work
	// moves on (dashed, a quarter, half, three quarters, solid with a tick), a cross for
	// work that was dropped and a pause mark in the warning colour for work that is
	// held up. The word stays available to assistive tech and as the hover title.
	if (variant === 'ring') {
		const stage = statusStage(status)
		const filled =
			stage === 'define' || stage === 'progress' || stage === 'review' || stage === 'done'
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 18 18"
				fill="none"
				role="img"
				aria-label={`Status ${label}`}
				className={cn(
					'shrink-0',
					stage === 'blocked'
						? 'text-warning'
						: filled
							? 'text-foreground'
							: 'text-muted-foreground',
					className,
				)}
			>
				<title>{capitalize(statusLabel(status))}</title>
				<circle
					cx="9"
					cy="9"
					r="6.5"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeDasharray={stage === 'todo' ? '2.2 2.2' : undefined}
					fill={stage === 'done' ? 'currentColor' : 'none'}
				/>
				{(stage === 'define' || stage === 'progress' || stage === 'review') && (
					<circle
						cx="9"
						cy="9"
						r="3"
						stroke="currentColor"
						strokeWidth="6"
						strokeDasharray={
							stage === 'define' ? '4.71 18.85' : stage === 'progress' ? '9.42 18.85' : '14.1 18.85'
						}
						transform="rotate(-90 9 9)"
					/>
				)}
				{stage === 'done' && (
					<path
						d="M6 9.2l2 2 4-4.2"
						className="stroke-background"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				)}
				{stage === 'cancelled' && (
					<path
						d="M6.5 6.5l5 5M11.5 6.5l-5 5"
						stroke="currentColor"
						strokeWidth="1.6"
						strokeLinecap="round"
					/>
				)}
				{stage === 'blocked' && (
					<path
						d="M7.4 6.4v5.2M10.6 6.4v5.2"
						stroke="currentColor"
						strokeWidth="1.8"
						strokeLinecap="round"
					/>
				)}
			</svg>
		)
	}

	// The bare status word, no dot and no pill — a citation pill, the For You
	// feed's card meta line and its row subtitle, and the Objects list row
	// (mockup 759) carry status as coloured text rather than as chrome. A dot
	// beside it would double the colour signal inside 11px of space.
	if (variant === 'word') {
		return (
			<span
				className={cn('shrink-0 whitespace-nowrap font-medium', colors.text, className)}
				aria-label={`Status ${label}`}
			>
				{capitalize(statusLabel(status))}
			</span>
		)
	}

	if (variant === 'dot-word') {
		return (
			<span
				className={cn(
					'inline-flex shrink-0 items-center gap-1 rounded px-1 text-[11px] leading-4',
					colors.text,
					onClick && 'cursor-pointer hover:opacity-80',
					className,
				)}
				onClick={onClick}
				onKeyDown={
					onClick
						? (e) => {
								if (e.key === 'Enter' || e.key === ' ') onClick()
							}
						: undefined
				}
				role={onClick ? 'button' : undefined}
				tabIndex={onClick ? 0 : undefined}
				aria-label={`Status ${label}`}
			>
				<span
					aria-hidden="true"
					data-testid="status-dot"
					className="h-1.5 w-1.5 rounded-full bg-current"
				/>
				{label}
			</span>
		)
	}

	return (
		<Badge
			variant="outline"
			className={cn(
				colors.bg,
				colors.text,
				onClick && 'cursor-pointer hover:opacity-80',
				className,
			)}
			onClick={onClick}
			onKeyDown={
				onClick
					? (e) => {
							if (e.key === 'Enter' || e.key === ' ') onClick()
						}
					: undefined
			}
			role={onClick ? 'button' : undefined}
			tabIndex={onClick ? 0 : undefined}
		>
			{label}
		</Badge>
	)
}

// Status words are sentence-cased at the point of display ("In review",
// "Blocked"): the shared `statusLabel` map only spells out the statuses the
// product ships; anything custom falls through as the raw, lowercase value.
function capitalize(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1)
}
