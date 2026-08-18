import { cn } from '@/lib/cn'

export function EmptyState({
	title,
	description,
	action,
	className,
	compact,
	icon,
	emphasis = 'inline',
}: {
	title: string
	description?: string
	action?: React.ReactNode
	className?: string
	/** Tightens the gap above `action` for space-constrained contexts (e.g. above
	 *  a composer that must stay reachable above a mobile on-screen keyboard). */
	compact?: boolean
	/** Rendered above the title. Size it at the call site. */
	icon?: React.ReactNode
	/** `inline` is the quiet in-list state. `page` is a screen's flagship empty
	 *  state — the For You caught-up panel, the Search zero state — where the
	 *  message is the whole screen and has to carry it. */
	emphasis?: 'inline' | 'page'
}) {
	const isPage = emphasis === 'page'
	return (
		<div className={cn('flex flex-col items-center justify-center py-16 text-center', className)}>
			{icon && <div className="mb-3 text-muted-foreground">{icon}</div>}
			<p
				className={cn(
					isPage
						? 'text-[17px] font-bold text-foreground'
						: 'text-sm font-medium text-muted-foreground',
				)}
			>
				{title}
			</p>
			{description && (
				<p
					className={cn(
						'text-muted-foreground',
						isPage ? 'mt-1.5 max-w-[48ch] text-[12.5px] leading-relaxed' : 'mt-1 text-xs',
					)}
				>
					{description}
				</p>
			)}
			{action && <div className={compact ? 'mt-2' : 'mt-4'}>{action}</div>}
		</div>
	)
}
