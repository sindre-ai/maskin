import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { getTypeColor } from '@/lib/constants'

export function TypeBadge({
	type,
	className,
	variant = 'badge',
}: {
	type: string
	className?: string
	variant?: 'badge' | 'mono' | 'tile'
}) {
	// The glyph tile is a compact colored square (command palette "Jump to"
	// rows, mirroring ActorAvatar's circle-with-initials pattern for agents) —
	// a single uppercase letter on the type's own status-badge color pair.
	if (variant === 'tile') {
		return (
			<span
				aria-hidden="true"
				title={type}
				className={cn(
					'inline-flex items-center justify-center rounded-md text-[11px] font-semibold uppercase',
					getTypeColor(type).bg,
					getTypeColor(type).text,
					className,
				)}
			>
				{type.charAt(0).toUpperCase()}
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
