import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { defaultTypeColor, typeColors, typeIcons } from '@/lib/constants'

export function TypeBadge({
	type,
	className,
	variant = 'badge',
	size = 'sm',
}: {
	type: string
	className?: string
	variant?: 'badge' | 'mono' | 'tile'
	/** `tile` only: 30px in card headers, 38px in list rows and detail headers. */
	size?: 'sm' | 'lg'
}) {
	// The tile is the type's visual anchor — a tinted square with the type's
	// lucide glyph, used wherever an object is the subject of a row or card
	// rather than a mention in running text.
	if (variant === 'tile') {
		const colors = typeColors[type] ?? defaultTypeColor
		const Icon = typeIcons[type]
		return (
			<span
				aria-hidden="true"
				className={cn(
					'grid shrink-0 place-items-center rounded-lg',
					size === 'lg' ? 'size-[38px]' : 'size-[30px]',
					colors.bg,
					colors.text,
					className,
				)}
			>
				{Icon && <Icon className={size === 'lg' ? 'size-[18px]' : 'size-[15px]'} />}
			</span>
		)
	}

	// The mono chip is the app's compact uppercase type label (used by the
	// Objects list rows); the badge pill is the richer default.
	if (variant === 'mono') {
		return (
			<span
				className={cn(
					'font-mono text-[10px] font-medium uppercase tracking-[0.09em] text-muted-foreground',
					className,
				)}
			>
				{type}
			</span>
		)
	}
	return (
		<Badge variant="ghost" className={cn('font-medium', className)}>
			{type}
		</Badge>
	)
}
