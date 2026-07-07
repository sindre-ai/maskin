import { cn } from '@/lib/cn'

export function UnreadBadge({
	count,
	className,
}: {
	count: number
	className?: string
}) {
	if (count <= 0) return null
	return (
		<span
			aria-label={`${count} unread`}
			className={cn(
				'inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-medium text-accent-foreground tabular-nums',
				className,
			)}
		>
			{count}
		</span>
	)
}
