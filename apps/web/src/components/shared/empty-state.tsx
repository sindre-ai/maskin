export function EmptyState({
	title,
	description,
	action,
}: {
	title: string
	description?: string
	action?: React.ReactNode
}) {
	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<p className="text-sm font-medium text-muted-foreground">{title}</p>
			{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
			{action && <div className="mt-4">{action}</div>}
		</div>
	)
}
