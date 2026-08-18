import { cn } from '@/lib/cn'

export function UnreadBadge({
	count,
	className,
	// True when the count is a capped page total rather than an exact figure —
	// renders "50+" instead of "50".
	overflow = false,
	// `pill` is the filled capsule used in dense list rows; `plain` is the v2
	// sidebar's bare brand-coloured numeral (mockup: 11.5px/600, no fill).
	variant = 'pill',
}: {
	count: number
	className?: string
	overflow?: boolean
	variant?: 'pill' | 'plain'
}) {
	if (count <= 0) return null
	const label = overflow ? `${count}+` : `${count}`
	return (
		<span
			aria-label={`${label} unread`}
			className={cn(
				'tabular-nums',
				variant === 'pill'
					? 'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-accent-foreground'
					: 'text-[11.5px] font-semibold text-brand',
				className,
			)}
		>
			{label}
		</span>
	)
}
