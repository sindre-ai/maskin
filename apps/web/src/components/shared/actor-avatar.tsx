import { cn } from '@/lib/cn'

export function ActorAvatar({
	name,
	type,
	size = 'sm',
	className,
	onClick,
}: {
	name: string
	type: string
	size?: 'sm' | 'md' | 'lg'
	className?: string
	onClick?: () => void
}) {
	const isAgent = type === 'agent'
	const sizeClasses =
		size === 'sm'
			? 'h-5 w-5 text-[10px]'
			: size === 'md'
				? 'h-7 w-7 text-xs'
				: 'h-12 w-12 text-base'
	const baseClasses = cn(
		'inline-flex items-center justify-center rounded-full font-medium',
		isAgent ? 'bg-primary/20 text-primary' : 'bg-zinc-700 text-zinc-300',
		sizeClasses,
		className,
	)
	const content = isAgent ? '⚡' : name.charAt(0).toUpperCase()

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
