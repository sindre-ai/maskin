import { cn } from '@/lib/cn'

export function EmptyState({
	title,
	description,
	action,
	className,
}: {
	title: string
	description?: string
	action?: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				'flex flex-col items-center justify-center py-[var(--space-10)] text-center',
				className,
			)}
		>
			<p className="text-label font-medium text-muted-foreground">{title}</p>
			{description && (
				<p className="mt-[var(--space-1)] text-caption text-muted-foreground">{description}</p>
			)}
			{action && <div className="mt-[var(--space-4)]">{action}</div>}
		</div>
	)
}
