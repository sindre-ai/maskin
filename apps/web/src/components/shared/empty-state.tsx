export function EmptyState({
	title,
	description,
	action,
	icon,
}: {
	title: string
	description?: string
	action?: React.ReactNode
	/** Optional leading glyph (e.g. a lucide icon) shown in a soft rounded chip. */
	icon?: React.ReactNode
}) {
	return (
		<div className="flex flex-col items-center justify-center px-6 py-16 text-center">
			{icon && (
				<div className="mb-3 flex size-10 items-center justify-center rounded-full border border-border bg-muted/40 text-muted-foreground [&_svg]:size-5">
					{icon}
				</div>
			)}
			<p className="text-sm font-medium text-foreground">{title}</p>
			{description && (
				<p className="mt-1 max-w-sm text-pretty text-xs leading-relaxed text-muted-foreground">
					{description}
				</p>
			)}
			{action && <div className="mt-4">{action}</div>}
		</div>
	)
}
