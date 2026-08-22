import { cn } from '@/lib/cn'

export function UnreadBadge({
	count,
	overflow,
	variant = 'pill',
	className,
}: {
	count: number
	/** True when `count` is a floor, not the exact total — renders "N+". */
	overflow?: boolean
	/** `pill` is the default accent chip; `plain` is a numeral-only look for
	 *  dense nav rows (the sidebar's Chats/For you counts). */
	variant?: 'pill' | 'plain'
	className?: string
}) {
	if (count <= 0) return null
	const label = overflow ? `${count}+` : `${count}`

	if (variant === 'plain') {
		return (
			<span
				aria-label={`${label} unread`}
				className={cn(
					'font-mono text-[10px] font-semibold tabular-nums text-muted-foreground',
					className,
				)}
			>
				{label}
			</span>
		)
	}

	return (
		<span
			aria-label={`${label} unread`}
			className={cn(
				'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-accent-foreground tabular-nums',
				className,
			)}
		>
			{label}
		</span>
	)
}
