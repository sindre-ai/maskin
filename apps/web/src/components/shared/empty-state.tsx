import { cn } from '@/lib/cn'

export function EmptyState({
	title,
	description,
	action,
	className,
	compact,
}: {
	title: string
	description?: string
	action?: React.ReactNode
	className?: string
	/** Tightens the gap above `action` for space-constrained contexts (e.g. above
	 *  a composer that must stay reachable above a mobile on-screen keyboard). */
	compact?: boolean
}) {
	return (
		<div className={cn('flex flex-col items-center justify-center py-16 text-center', className)}>
			<p className="text-sm font-medium text-muted-foreground">{title}</p>
			{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
			{action && <div className={compact ? 'mt-2' : 'mt-4'}>{action}</div>}
		</div>
	)
}
