import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

export function TypeBadge({
	type,
	className,
	variant = 'badge',
}: {
	type: string
	className?: string
	variant?: 'badge' | 'mono'
}) {
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
