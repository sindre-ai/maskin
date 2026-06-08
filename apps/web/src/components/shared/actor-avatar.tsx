import { cn } from '@/lib/cn'
import { useState } from 'react'

export function ActorAvatar({
	name,
	type,
	size = 'sm',
	className,
	avatarUrl,
}: {
	name: string
	type: string
	size?: 'sm' | 'md' | 'lg'
	className?: string
	avatarUrl?: string | null
}) {
	const isAgent = type === 'agent'
	const sizeClasses =
		size === 'sm'
			? 'h-5 w-5 text-[10px]'
			: size === 'md'
				? 'h-7 w-7 text-xs'
				: 'h-12 w-12 text-base'

	const [imgFailed, setImgFailed] = useState(false)

	if (avatarUrl && !imgFailed) {
		return (
			<img
				src={avatarUrl}
				alt={name}
				title={name}
				className={cn('inline-block rounded-full object-cover', sizeClasses, className)}
				onError={() => setImgFailed(true)}
			/>
		)
	}

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
