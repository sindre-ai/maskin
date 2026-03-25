import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

export function TypeBadge({ type, className }: { type: string; className?: string }) {
	return (
		<Badge variant="ghost" className={cn('text-xs font-normal', className)}>
			{type}
		</Badge>
	)
}
