import { cn } from '@/lib/cn'
import { Bot } from 'lucide-react'

export function ActorAvatar({
	name,
	type,
	size = 'sm',
	className,
	onClick,
}: {
	name: string
	type: string
	size?: 'sm' | 'md'
	className?: string
	onClick?: () => void
}) {
	const isAgent = type === 'agent'
	const sizeClasses = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-7 w-7 text-xs'
	const baseClasses = cn(
		'inline-flex items-center justify-center rounded-full font-medium',
		isAgent ? 'bg-primary/20 text-primary' : 'bg-zinc-700 text-zinc-300',
		sizeClasses,
		className,
	)
	const content = isAgent ? (
		<Bot size={size === 'sm' ? 12 : 16} aria-hidden />
	) : (
		name.charAt(0).toUpperCase()
	)

	if (onClick) {
		return (
			<button
				type="button"
				onClick={onClick}
				title={name}
				className={cn(baseClasses, 'cursor-pointer hover:opacity-80 transition-opacity')}
			>
				{content}
			</button>
		)
	}

	return (
		<span className={baseClasses} title={name}>
			{content}
		</span>
	)
}
