import { cn } from '@/lib/cn'

export function ActorAvatar({
	name,
	type,
	size = 'sm',
	className,
}: {
	name: string
	type: string
	size?: 'sm' | 'md'
	className?: string
}) {
	const isAgent = type === 'agent'
	const sizeClasses = size === 'sm' ? 'h-5 w-5 text-[10px]' : 'h-7 w-7 text-xs'

	return (
		<span
			className={cn(
				'inline-flex items-center justify-center rounded-full font-medium',
				isAgent ? 'bg-primary/20 text-primary' : 'bg-zinc-700 text-zinc-300',
				sizeClasses,
				className,
			)}
			title={name}
		>
			{isAgent ? '⚡' : name.charAt(0).toUpperCase()}
		</span>
	)
}
