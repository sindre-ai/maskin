import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { defaultStatusColor, statusColors, statusLabel } from '@/lib/constants'

type StatusBadgeVariant = 'default' | 'dot-word' | 'word'

export function StatusBadge({
	status,
	onClick,
	className,
	variant = 'default',
}: {
	status: string
	onClick?: () => void
	className?: string
	variant?: StatusBadgeVariant
}) {
	// `defaultStatusColor` rather than a literal: statuses are workspace-
	// configurable, and the old fallback was light text sized for a dark pill.
	// The `word` and `dot-word` variants drop the pill and render `text` on the
	// surface itself, where `text-zinc-300` is unreadable in light mode.
	const colors = statusColors[status] ?? defaultStatusColor
	const label = status.replace(/_/g, ' ')

	// The bare status word, no dot and no pill — a citation pill and the For You
	// feed's meta line carry status as coloured text rather than as chrome.
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

// Status words are sentence-cased at the point of display: the shared
// `statusLabel` map only spells out the statuses the product ships; anything
// custom falls through as the raw, lowercase value.
function capitalize(label: string): string {
	return label.charAt(0).toUpperCase() + label.slice(1)
}
