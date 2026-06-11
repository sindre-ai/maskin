import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

export function SourceBadge({ source, className }: { source: string; className?: string }) {
	return (
		<Badge variant="secondary" className={cn('font-normal', className)}>
			{source}
		</Badge>
	)
}
