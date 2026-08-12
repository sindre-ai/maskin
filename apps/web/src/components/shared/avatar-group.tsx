import { cn } from '@/lib/cn'
import { ActorAvatar } from './actor-avatar'

export interface AvatarGroupItem {
	id?: string
	name: string
	type?: string
	imageUrl?: string
}

interface AvatarGroupProps {
	items: AvatarGroupItem[]
	/** How many avatars to show before collapsing the rest into an overflow chip. */
	max?: number
	size?: 'sm' | 'md'
	className?: string
	/** Show the trailing "+N" overflow chip when items exceed `max`. */
	showOverflow?: boolean
}

/**
 * Overlapping avatar stack (ringed on the surface colour so each reads on top
 * of the previous). Identity colour comes through AVATAR_PALETTE via
 * ActorAvatar; every avatar is uniform rounded-full.
 */
export function AvatarGroup({
	items,
	max = 4,
	size = 'sm',
	className,
	showOverflow = true,
}: AvatarGroupProps) {
	const visible = items.slice(0, max)
	const overflow = Math.max(0, items.length - visible.length)

	return (
		<div className={cn('inline-flex items-center -space-x-1.5', className)}>
			{visible.map((item) => (
				<ActorAvatar
					key={item.id ?? item.name}
					name={item.name}
					type={item.type ?? ''}
					id={item.id}
					imageUrl={item.imageUrl}
					size={size}
					className="ring-2 ring-background"
				/>
			))}
			{showOverflow && overflow > 0 ? (
				<span
					title={`${overflow} more`}
					className={cn(
						'inline-flex items-center justify-center rounded-full bg-secondary font-medium text-secondary-foreground ring-2 ring-background',
						size === 'sm' ? 'h-5 w-5 text-xs' : 'h-7 w-7 text-sm',
					)}
				>
					+{overflow}
				</span>
			) : null}
		</div>
	)
}
