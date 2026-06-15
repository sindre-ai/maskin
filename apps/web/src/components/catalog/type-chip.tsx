import { Badge } from '@/components/ui/badge'
import type { CatalogItemType } from '@/lib/api'
import { cn } from '@/lib/cn'

const TYPE_LABEL: Record<CatalogItemType, string> = {
	actor: 'Agent',
	trigger: 'Trigger',
	skill: 'Skill',
	integration: 'Integration',
}

const TYPE_DOT: Record<CatalogItemType, string> = {
	actor: 'bg-blue-500',
	trigger: 'bg-green-500',
	skill: 'bg-yellow-500',
	integration: 'bg-purple-500',
}

export function TypeChip({ type, className }: { type: CatalogItemType; className?: string }) {
	return (
		<Badge
			variant="outline"
			className={cn('gap-1.5 border-border bg-muted text-muted-foreground font-medium', className)}
		>
			<span className={cn('h-1.5 w-1.5 rounded-full', TYPE_DOT[type])} aria-hidden />
			{TYPE_LABEL[type]}
		</Badge>
	)
}
