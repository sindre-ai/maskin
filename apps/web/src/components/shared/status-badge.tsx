import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import { statusColors } from '@/lib/constants'

export function StatusBadge({
	status,
	onClick,
	className,
}: {
	status: string
	onClick?: () => void
	className?: string
}) {
	const colors = statusColors[status] ?? { bg: 'bg-zinc-700', text: 'text-zinc-300' }

	return (
		<Badge
			variant="outline"
			className={cn(
				colors.bg,
				colors.text,
				onClick && 'cursor-pointer hover:opacity-80',
				className,
			)}
			onClick={onClick}
			onKeyDown={
				onClick
					? (e) => {
							if (e.key === 'Enter' || e.key === ' ') onClick()
						}
					: undefined
			}
			role={onClick ? 'button' : undefined}
			tabIndex={onClick ? 0 : undefined}
		>
			{status.replace(/_/g, ' ')}
		</Badge>
	)
}
