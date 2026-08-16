import { ActorAvatar } from '@/components/shared/actor-avatar'
import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'
import { forwardRef } from 'react'

export interface ParticipantAvatarSpec {
	id: string
	name: string
	type: 'human' | 'agent'
}

/**
 * Stacked avatars with an overflow count and a caret — clicking opens the
 * IN THIS CHAT panel. The caller wires the trigger via `onClick` (desktop
 * popover) or by wrapping this in a Sheet trigger (mobile).
 */
export const ParticipantStack = forwardRef<
	HTMLButtonElement,
	{
		participants: ParticipantAvatarSpec[]
		maxVisible?: number
		onClick?: () => void
		className?: string
	}
>(function ParticipantStack({ participants, maxVisible = 3, onClick, className, ...rest }, ref) {
	const visible = participants.slice(0, maxVisible)
	const overflow = Math.max(0, participants.length - visible.length)
	const label =
		participants.length > 0
			? `In this chat: ${participants.map((p) => p.name).join(', ')}`
			: 'In this chat'

	return (
		<button
			ref={ref}
			type="button"
			onClick={onClick}
			aria-label={label}
			className={cn(
				'inline-flex min-h-[44px] items-center gap-1 rounded-full px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
				className,
			)}
			{...rest}
		>
			<span className="inline-flex -space-x-1.5">
				{visible.map((p) => (
					<ActorAvatar
						key={p.id}
						name={p.name}
						type={p.type}
						id={p.id}
						size="sm"
						className="ring-2 ring-bg-surface"
					/>
				))}
			</span>
			{overflow > 0 && <span className="ml-1 font-semibold text-foreground">+{overflow}</span>}
			<ChevronDown size={12} aria-hidden className="ml-0.5 text-muted-foreground" />
		</button>
	)
})
