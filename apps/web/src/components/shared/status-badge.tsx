import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { statusColors, statusLabel } from '@/lib/constants'

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
	const colors = statusColors[status] ?? { bg: 'bg-zinc-700', text: 'text-zinc-300' }
	const label = status.replace(/_/g, ' ')

	// The bare status word — no dot, no pill. The Objects list row carries
	// status as coloured text (mockup 759); a dot beside it would double the
	// colour signal inside 11px of space.
	if (variant === 'word') {
		return (
			<span
				className={cn('shrink-0 whitespace-nowrap font-medium', colors.text, className)}
				aria-label={`Status ${label}`}
			>
				{statusLabel(status)}
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
